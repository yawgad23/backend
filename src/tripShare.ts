import type { Express, Request, Response } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { contactClaimDocumentId, normalizeAccountPhone } from './accountContactClaims';
import { ADMIN_COLLECTIONS, adminFirestore, getAdminAuth, getAdminDb } from './firebaseAdmin';
import { sendTripSharePush } from './pushNotifications';

const ACTIVE_STATUSES = new Set(['matched', 'driver_arriving', 'driver_arrived', 'in_progress']);
const SHARE_DURATION_MS = 8 * 60 * 60 * 1000;
const MAX_RECIPIENT_SHARES_PER_RIDE = 5;
const LOCATION_FRESHNESS_MS = 2 * 60 * 1000;

type TripShare = Record<string, any>;

const recipientInput = z.object({
  phone: z.string().trim().min(7).max(40),
});

function tokenFrom(req: Request) {
  return String(req.params.token || '').trim();
}

function bearerToken(req: Request) {
  const auth = String(req.headers.authorization || '');
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
}

async function authenticatedUid(req: Request, response: Response): Promise<string | null> {
  const token = bearerToken(req);
  if (!token) {
    response.status(401).json({ success: false, message: 'Please sign in again.' });
    return null;
  }
  try {
    return (await getAdminAuth().verifyIdToken(token, true)).uid;
  } catch {
    response.status(401).json({ success: false, message: 'Your session has expired. Please sign in again.' });
    return null;
  }
}

function rideDriverId(ride: Record<string, any>) {
  return String(ride.driver_id || ride.driverId || '').trim();
}

function currentAssignmentMatches(share: TripShare, ride: Record<string, any>) {
  const assignedAtShare = String(share.assignment_driver_id || '').trim();
  return Boolean(assignedAtShare) && assignedAtShare === rideDriverId(ride);
}

function validPoint(value: unknown): value is { latitude?: unknown; longitude?: unknown; lat?: unknown; lng?: unknown } {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  const latitude = Number(item.latitude ?? item.lat);
  const longitude = Number(item.longitude ?? item.lng);
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}

function point(value: Record<string, unknown> | null | undefined) {
  if (!validPoint(value)) return null;
  return { latitude: Number(value.latitude ?? value.lat), longitude: Number(value.longitude ?? value.lng) };
}

function cleanText(value: unknown, fallback = '', limit = 140) {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return (text || fallback).slice(0, limit);
}

function safeRoutePoints(value: unknown): Array<[number, number]> {
  if (!Array.isArray(value)) return [];
  const points: Array<[number, number]> = [];
  for (const item of value.slice(0, 400)) {
    if (Array.isArray(item) && validPoint({ lat: item[0], lng: item[1] })) points.push([Number(item[0]), Number(item[1])]);
    else if (validPoint(item)) {
      const p = item as Record<string, unknown>;
      points.push([Number(p.latitude ?? p.lat), Number(p.longitude ?? p.lng)]);
    }
  }
  return points.length >= 2 ? points : [];
}

function locationFromDriver(driver: Record<string, any> | null) {
  const raw = driver?.current_location;
  const value = point(raw);
  if (!value) return null;
  const updatedAt = cleanText(raw?.recorded_at || raw?.timestamp || driver?.last_location_update, '', 80);
  const updatedAtMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedAtMs) || Date.now() - updatedAtMs > LOCATION_FRESHNESS_MS || updatedAtMs > Date.now() + 60_000) return null;
  return { ...value, heading: Number.isFinite(Number(raw?.heading)) ? Number(raw.heading) : 0, updatedAt };
}

function activeShare(share: TripShare, ride: Record<string, any>) {
  return String(share.status || '') === 'active'
    && ACTIVE_STATUSES.has(String(ride.status || ''))
    && new Date(String(share.expires_at || 0)).getTime() > Date.now()
    && currentAssignmentMatches(share, ride);
}

function recipientLockId(rideId: string, recipientUid: string) {
  return createHash('sha256').update(`hy3n-trip-share:v1:${rideId}:${recipientUid}`).digest('hex');
}

/** Ends shares fail-closed. Every recipient live read also checks this state. */
export async function endActiveTripSharesForRide(rideId: string, reason: 'rider_revoked' | 'ride_ended' | 'assignment_changed' | 'replaced') {
  const shares = await adminFirestore.list(ADMIN_COLLECTIONS.TRIP_SHARES, { ride_id: rideId }, null, 'desc', 100);
  const active = shares.filter((share) => String(share.status || '') === 'active');
  const endedAt = new Date().toISOString();
  const statePatch = reason === 'rider_revoked' || reason === 'replaced'
    ? { status: 'revoked' as const, revoked_at: endedAt, revoked_reason: reason }
    : { status: 'ended' as const, ended_at: endedAt, ended_reason: reason };
  await Promise.all(active.map((share) => adminFirestore.update(ADMIN_COLLECTIONS.TRIP_SHARES, share.id, {
    ...statePatch,
  })));
  return { endedAt, count: active.length };
}

async function findSharedRide(token: string): Promise<{ share: TripShare; ride: Record<string, any> } | null> {
  if (!token || token.length < 24) return null;
  const share = await adminFirestore.get(ADMIN_COLLECTIONS.TRIP_SHARES, token);
  if (!share || String(share.share_kind || 'public_link') !== 'public_link') return null;
  const ride = await adminFirestore.get(ADMIN_COLLECTIONS.RIDES, String(share.ride_id || ''));
  return ride ? { share, ride } : null;
}

async function publicTrackingState(token: string) {
  const shared = await findSharedRide(token);
  if (!shared) return { found: false };
  const { share, ride } = shared;
  if (!activeShare(share, ride)) return { found: true, active: false, status: String(ride.status || 'ended') };
  const driver = rideDriverId(ride) ? await adminFirestore.get(ADMIN_COLLECTIONS.DRIVER_PROFILES, rideDriverId(ride)) : null;
  return {
    found: true,
    active: true,
    status: String(ride.status),
    pickup: cleanText(ride.pickup_address || ride.pickup?.address, 'Pickup'),
    destination: cleanText(ride.destination_address || ride.destination?.address, 'Destination'),
    driverName: cleanText(ride.driver_name, 'Your HY3N driver', 80),
    vehicle: cleanText(ride.driver_vehicle, '', 80),
    plate: cleanText(ride.driver_plate, '', 40),
    location: locationFromDriver(driver),
  };
}

function trackingPage(token: string) {
  const tokenJson = JSON.stringify(token).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><title>HY3N Live Trip</title><style>body{margin:0;background:#151515;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}.card{margin:18px;padding:20px;background:#181818;border-radius:22px}.brand{color:#d4af37;font-weight:900}.title{font-size:22px;font-weight:800;margin:8px 0}.meta{color:#c7c7c7;line-height:1.5}</style></head><body><section class="card"><div class="brand">HY3N · LIVE TRIP</div><div id="title" class="title">Loading live trip…</div><div id="meta" class="meta">Checking the trip link securely.</div></section><script>const token=${tokenJson};async function refresh(){try{const r=await fetch('/api/public/trips/'+encodeURIComponent(token)+'/status',{cache:'no-store'});const s=await r.json();document.getElementById('title').textContent=!s.found?'Trip link unavailable':!s.active?'Trip sharing has ended':(s.driverName+' is on the way');document.getElementById('meta').textContent=s.active?(s.pickup+' → '+s.destination):'This link may be invalid, revoked, expired, or the trip has ended.'}catch(e){document.getElementById('meta').textContent='Connection interrupted. Retrying…'}}refresh();setInterval(refresh,5000);</script></body></html>`;
}

async function createRecipientShare(input: { ride: Record<string, any>; riderId: string; recipientPhone: string }) {
  const claimId = contactClaimDocumentId('rider', 'phone', input.recipientPhone);
  const claim = await adminFirestore.get(ADMIN_COLLECTIONS.ACCOUNT_CONTACT_CLAIMS, claimId);
  const recipientUid = cleanText(claim?.owner_uid, '', 128);
  // Deliberately neutral: the sender cannot use this endpoint to discover who has HY3N.
  if (!recipientUid || recipientUid === input.riderId) {
    throw new Error('That trusted person cannot receive this HY3N trip share. Check the contact and ask them to sign in to HY3N Rider.');
  }

  const shareId = randomBytes(24).toString('base64url');
  let effectiveShareId = shareId;
  const now = new Date();
  const startedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + SHARE_DURATION_MS).toISOString();
  const db = getAdminDb();
  const lockRef = db.collection('trip_share_recipient_locks').doc(recipientLockId(String(input.ride.id), recipientUid));
  const shareRef = db.collection(ADMIN_COLLECTIONS.TRIP_SHARES).doc(shareId);

  await db.runTransaction(async (transaction) => {
    const [rideSnapshot, lockSnapshot] = await Promise.all([
      transaction.get(db.collection(ADMIN_COLLECTIONS.RIDES).doc(String(input.ride.id))),
      transaction.get(lockRef),
    ]);
    const currentRide: Record<string, any> | null = rideSnapshot.exists ? { id: rideSnapshot.id, ...(rideSnapshot.data() || {}) } : null;
    if (!currentRide || String(currentRide.rider_id || '') !== input.riderId || !ACTIVE_STATUSES.has(String(currentRide.status || '')) || !rideDriverId(currentRide)) {
      throw new Error('Only a currently assigned active trip can be shared.');
    }
    const existingShareId = cleanText(lockSnapshot.get('share_id'), '', 128);
    if (existingShareId) {
      const existingRef = db.collection(ADMIN_COLLECTIONS.TRIP_SHARES).doc(existingShareId);
      const existing = await transaction.get(existingRef);
      if (existing.exists && String(existing.get('status') || '') === 'active' && Date.parse(String(existing.get('expires_at') || '')) > Date.now()) {
        effectiveShareId = existingShareId;
        transaction.update(existingRef, { expires_at: expiresAt, updated_date: startedAt });
        transaction.set(lockRef, { share_id: existingShareId, updated_date: startedAt }, { merge: true });
        return;
      }
    }
    const activeShares = await transaction.get(db.collection(ADMIN_COLLECTIONS.TRIP_SHARES).where('ride_id', '==', String(input.ride.id)).where('status', '==', 'active'));
    const recipientShares = activeShares.docs.filter((doc) => String(doc.get('share_kind') || '') === 'recipient').length;
    if (recipientShares >= MAX_RECIPIENT_SHARES_PER_RIDE) throw new Error('You can share this trip with up to five trusted people. Stop sharing with someone before adding another.');
    transaction.create(shareRef, {
      share_kind: 'recipient',
      ride_id: String(input.ride.id),
      rider_id: input.riderId,
      recipient_uid: recipientUid,
      status: 'active',
      assignment_driver_id: rideDriverId(currentRide),
      started_at: startedAt,
      expires_at: expiresAt,
      created_date: startedAt,
      updated_date: startedAt,
    });
    transaction.set(lockRef, { ride_id: String(input.ride.id), recipient_uid: recipientUid, share_id: shareId, updated_date: startedAt }, { merge: true });
    transaction.update(rideSnapshot.ref, { sharing_active: true, share_started_at: startedAt, share_expires_at: expiresAt, updated_date: startedAt });
  });

  return { shareId: effectiveShareId, recipientUid, expiresAt };
}

function recipientSnapshot(shareId: string, ride: Record<string, any>, driver: Record<string, any> | null) {
  const route = ride.live_route_metrics && typeof ride.live_route_metrics === 'object' ? ride.live_route_metrics : {};
  const pickup = point(ride.pickup);
  const destination = point(ride.destination);
  return {
    success: true,
    active: true,
    share: {
      id: shareId,
      status: cleanText(ride.status, 'active', 40),
      pickup: pickup ? { ...pickup, label: cleanText(ride.pickup_address || ride.pickup?.address || ride.pickup?.name, 'Pickup') } : null,
      destination: destination ? { ...destination, label: cleanText(ride.destination_address || ride.destination?.address || ride.destination?.name, 'Destination') } : null,
      driver: {
        name: cleanText(ride.driver_name, 'HY3N Driver', 80),
        vehicle: cleanText(ride.driver_vehicle, '', 80),
        plate: cleanText(ride.driver_plate, '', 40),
        location: locationFromDriver(driver),
      },
      route: {
        points: safeRoutePoints(route.points),
        updatedAt: cleanText(route.updated_at || route.calculated_at, '', 80) || null,
        durationMinutes: Number.isFinite(Number(route.duration_minutes)) ? Number(route.duration_minutes) : null,
        distanceKm: Number.isFinite(Number(route.distance_km)) ? Number(route.distance_km) : null,
      },
    },
  };
}

export function registerTripShareRoutes(app: Express) {
  app.post('/api/rider/trips/:rideId/share/recipient', async (req, res) => {
    const riderId = await authenticatedUid(req, res);
    if (!riderId) return;
    const input = recipientInput.safeParse(req.body);
    const phone = input.success ? normalizeAccountPhone(input.data.phone) : null;
    if (!phone) {
      res.status(400).json({ success: false, message: 'Enter a valid Ghana mobile number for your trusted person.' });
      return;
    }
    try {
      const ride = await adminFirestore.get(ADMIN_COLLECTIONS.RIDES, String(req.params.rideId || ''));
      if (!ride || String(ride.rider_id || '') !== riderId) {
        res.status(404).json({ success: false, message: 'Ride not found.' });
        return;
      }
      const created = await createRecipientShare({ ride, riderId, recipientPhone: phone });
      await sendTripSharePush({ shareId: created.shareId, rideId: String(ride.id), recipientUid: created.recipientUid });
      res.status(201).json({ success: true, shareId: created.shareId, expiresAt: created.expiresAt });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Trip sharing is temporarily unavailable.';
      console.error('[TripShare] Recipient share creation failed:', { rideId: String(req.params.rideId || ''), message });
      res.status(409).json({ success: false, message });
    }
  });

  app.get('/api/trip-shares/:shareId/live', async (req, res) => {
    const recipientUid = await authenticatedUid(req, res);
    if (!recipientUid) return;
    const shareId = cleanText(req.params.shareId, '', 128);
    try {
      const share = await adminFirestore.get(ADMIN_COLLECTIONS.TRIP_SHARES, shareId);
      if (!share || String(share.share_kind || '') !== 'recipient' || String(share.recipient_uid || '') !== recipientUid) {
        res.status(404).set('Cache-Control', 'no-store, private').json({ success: false, active: false });
        return;
      }
      const ride = await adminFirestore.get(ADMIN_COLLECTIONS.RIDES, String(share.ride_id || ''));
      if (!ride || !activeShare(share, ride)) {
        res.status(410).set('Cache-Control', 'no-store, private').json({ success: false, active: false });
        return;
      }
      const driver = await adminFirestore.get(ADMIN_COLLECTIONS.DRIVER_PROFILES, rideDriverId(ride));
      res.status(200).set('Cache-Control', 'no-store, private').json(recipientSnapshot(shareId, ride, driver));
    } catch (error) {
      console.error('[TripShare] Recipient live snapshot failed:', { shareId });
      res.status(503).set('Cache-Control', 'no-store, private').json({ success: false, active: false });
    }
  });

  app.post('/api/rider/trips/:rideId/share', async (req, res) => {
    const riderId = await authenticatedUid(req, res);
    if (!riderId) return;
    try {
      const ride = await adminFirestore.get(ADMIN_COLLECTIONS.RIDES, String(req.params.rideId || ''));
      if (!ride || String(ride.rider_id || '') !== riderId) {
        res.status(404).json({ success: false, message: 'Ride not found.' });
        return;
      }
      if (!ACTIVE_STATUSES.has(String(ride.status || '')) || !rideDriverId(ride)) {
        res.status(409).json({ success: false, message: 'Only a currently assigned active trip can be shared.' });
        return;
      }
      const token = randomBytes(24).toString('base64url');
      const startedAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + SHARE_DURATION_MS).toISOString();
      await adminFirestore.set(ADMIN_COLLECTIONS.TRIP_SHARES, token, { share_kind: 'public_link', ride_id: ride.id, rider_id: riderId, assignment_driver_id: rideDriverId(ride), status: 'active', started_at: startedAt, expires_at: expiresAt });
      await adminFirestore.update(ADMIN_COLLECTIONS.RIDES, ride.id, { sharing_active: true, share_started_at: startedAt, share_expires_at: expiresAt });
      const configuredOrigin = process.env.PUBLIC_TRACKING_BASE_URL?.replace(/\/$/, '');
      if (!configuredOrigin || !/^https:\/\//.test(configuredOrigin)) throw new Error('Public tracking is not configured. Use Share in HY3N for a trusted person.');
      res.status(201).json({ success: true, trackingUrl: `${configuredOrigin}/track/${token}`, expiresAt });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Live trip sharing is temporarily unavailable.';
      console.error('[TripShare] Link generation failed:', { message });
      res.status(503).json({ success: false, message });
    }
  });

  app.delete('/api/rider/trips/:rideId/share', async (req, res) => {
    const riderId = await authenticatedUid(req, res);
    if (!riderId) return;
    try {
      const ride = await adminFirestore.get(ADMIN_COLLECTIONS.RIDES, String(req.params.rideId || ''));
      if (!ride || String(ride.rider_id || '') !== riderId) {
        res.status(404).json({ success: false, message: 'Ride not found.' });
        return;
      }
      const result = await endActiveTripSharesForRide(String(ride.id), 'rider_revoked');
      await adminFirestore.update(ADMIN_COLLECTIONS.RIDES, String(ride.id), { sharing_active: false, share_revoked_at: result.endedAt });
      res.status(200).json({ success: true, revokedAt: result.endedAt });
    } catch {
      res.status(503).json({ success: false, message: 'Trip sharing could not be stopped. Please try again.' });
    }
  });

  app.get('/track/:token', (req, res) => res.status(200).set('Cache-Control', 'no-store, private').type('html').send(trackingPage(tokenFrom(req))));
  app.get('/api/public/trips/:token/status', async (req, res) => {
    try {
      res.status(200).set('Cache-Control', 'no-store, private').json(await publicTrackingState(tokenFrom(req)));
    } catch {
      res.status(503).set('Cache-Control', 'no-store, private').json({ found: false });
    }
  });
}
