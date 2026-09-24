import crypto from 'crypto';
import type { Express, Request, Response } from 'express';
import { getMessaging } from 'firebase-admin/messaging';
import { z } from 'zod';
import { ADMIN_COLLECTIONS, adminFirestore, getAdminAuth } from './firebaseAdmin';

const LIVE_ACTIVITY_COLLECTION = 'rider_live_activities';
const UPDATE_INTERVAL_MS = 30_000;
const activityTokenInput = z.object({
  rideId: z.string().min(1).max(160),
  activityId: z.string().min(1).max(220),
  fcmToken: z.string().min(20).max(4096),
  activityPushToken: z.string().min(20).max(4096),
});

type Point = { latitude: number; longitude: number };
type ActivityEvent = 'update' | 'end';

function cleanText(value: unknown, fallback = '', maximum = 120) {
  const text = String(value ?? fallback).replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.slice(0, maximum) || fallback;
}

function maybePoint(value: any): Point | null {
  const latitude = Number(value?.latitude ?? value?.lat);
  const longitude = Number(value?.longitude ?? value?.lng);
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    ? { latitude, longitude }
    : null;
}

function distanceKm(from: Point, to: Point) {
  const radians = Math.PI / 180;
  const dLat = (to.latitude - from.latitude) * radians;
  const dLng = (to.longitude - from.longitude) * radians;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(from.latitude * radians) * Math.cos(to.latitude * radians) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatAccraTime(timestamp: number) {
  return new Intl.DateTimeFormat('en-GH', {
    timeZone: 'Africa/Accra', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(timestamp));
}

function activityDocumentId(rideId: string, activityId: string) {
  return crypto.createHash('sha256').update(`${rideId}:${activityId}`).digest('hex');
}

async function authenticatedUid(req: Request, res: Response) {
  const token = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) {
    res.status(401).json({ success: false, message: 'Please sign in before enabling Live Activity updates.' });
    return null;
  }
  try {
    return (await getAdminAuth().verifyIdToken(token)).uid;
  } catch {
    res.status(401).json({ success: false, message: 'Your session has expired. Please sign in again.' });
    return null;
  }
}

function riderIdForRide(ride: Record<string, any>) {
  return cleanText(ride.rider_id || ride.riderId || ride.user_id, '', 160);
}

async function roadRouteMetrics(from?: Point, to?: Point) {
  if (!from || !to) return null;
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${from.longitude},${from.latitude};${to.longitude},${to.latitude}?overview=false`;
    const response = await fetch(url, { signal: AbortSignal.timeout(4_000) });
    const body = await response.json().catch(() => null) as any;
    const route = response.ok ? body?.routes?.[0] : null;
    const distanceKm = Number(route?.distance) / 1000;
    const durationMinutes = Number(route?.duration) / 60;
    return Number.isFinite(distanceKm) && distanceKm >= 0 && Number.isFinite(durationMinutes) && durationMinutes >= 0
      ? { distanceKm, durationMinutes }
      : null;
  } catch {
    // Lock Screen updates retain a useful traffic-aware fallback if the public
    // router is unreachable; they must not interrupt Driver GPS processing.
    return null;
  }
}

async function liveActivityPresentation(ride: Record<string, any>, driverLocation?: Point) {
  const status = cleanText(ride.status, 'driver_arriving', 40);
  const onTrip = status === 'in_progress';
  const completed = status === 'completed' || status === 'cancelled';
  const target = onTrip ? maybePoint(ride.destination) : maybePoint(ride.pickup);
  const fallbackMinutes = onTrip
    ? Number(ride.estimated_duration_minutes ?? ride.duration ?? 12)
    : Number(ride.eta_minutes ?? 5);
  const directKm = driverLocation && target ? distanceKm(driverLocation, target) : NaN;
  // A conservative road/traffic estimate. The Rider foreground map replaces it
  // with OSRM when open; this server value keeps the Lock Screen useful when it
  // is not open without exposing a third-party map key.
  const routeKm = Number.isFinite(directKm) ? directKm * 1.23 : NaN;
  const speedKmh = onTrip ? 22 : 18;
  const road = await roadRouteMetrics(driverLocation, target || undefined);
  const etaMinutes = road
    ? Math.max(1, Math.ceil(road.durationMinutes))
    : Number.isFinite(routeKm)
      ? Math.max(1, Math.ceil((routeKm / speedKmh) * 60))
    : Math.max(1, Math.ceil(Number.isFinite(fallbackMinutes) ? fallbackMinutes : 5));
  const bookedDistanceKm = Number(ride.estimated_distance_km ?? ride.distance_km ?? ride.distance);
  const routeProgress = onTrip && road && Number.isFinite(bookedDistanceKm) && bookedDistanceKm > 0
    ? Math.max(0.02, Math.min(0.98, 1 - (road.distanceKm / bookedDistanceKm)))
    : onTrip ? 0.5 : 0.15;
  const arrivalAt = Date.now() + etaMinutes * 60_000;
  const destinationName = cleanText(ride.destination?.name || ride.destination?.address || ride.destination_name, 'your destination', 80);
  const pickupName = cleanText(ride.pickup?.name || ride.pickup?.address || ride.pickup_name, 'your pickup point', 80);
  const driverName = cleanText(ride.driver?.name || ride.driver_name, 'Your HY3N driver', 60);
  const vehicle = cleanText(ride.driver_vehicle || `${ride.driver_vehicle_make || ''} ${ride.driver_vehicle_model || ''}`, '', 70);

  if (completed) {
    return {
      event: 'end' as ActivityEvent,
      title: status === 'completed' ? 'Trip complete' : 'Ride cancelled',
      subtitle: status === 'completed' ? 'Thank you for riding with HY3N' : 'Open HY3N to book another ride',
      arrivalAt: null as number | null,
      progress: 1,
    };
  }
  if (status === 'driver_arrived') {
    return {
      event: 'update' as ActivityEvent,
      title: 'Your driver has arrived',
      subtitle: `Meet ${driverName} at ${pickupName}`,
      arrivalAt: Date.now() + 60_000,
      progress: 1,
    };
  }
  if (onTrip) {
    return {
      event: 'update' as ActivityEvent,
      title: `Dropoff at ${formatAccraTime(arrivalAt)}`,
      subtitle: `Heading to ${destinationName}`,
      arrivalAt,
      progress: routeProgress,
    };
  }
  return {
    event: 'update' as ActivityEvent,
    title: `Pickup in ${etaMinutes} min`,
      subtitle: `${driverName}${vehicle ? ` · ${vehicle}` : ''} is heading to ${pickupName}`,
      arrivalAt,
      progress: routeProgress,
  };
}

/** Securely stores the per-activity APNs token and its paired FCM token. */
export function registerLiveActivityRoutes(app: Express) {
  app.post('/api/live-activities/token', async (req, res) => {
    const uid = await authenticatedUid(req, res);
    if (!uid) return;
    const parsed = activityTokenInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, message: 'Invalid Live Activity token registration.' });
      return;
    }
    const input = parsed.data;
    const ride = await adminFirestore.get(ADMIN_COLLECTIONS.RIDES, input.rideId);
    if (!ride || riderIdForRide(ride) !== uid) {
      res.status(404).json({ success: false, message: 'Active ride not found.' });
      return;
    }

    const id = activityDocumentId(input.rideId, input.activityId);
    await adminFirestore.set(LIVE_ACTIVITY_COLLECTION, id, {
      ride_id: input.rideId,
      rider_id: uid,
      activity_id: input.activityId,
      fcm_token: input.fcmToken,
      activity_push_token: input.activityPushToken,
      active: true,
      token_updated_at: new Date().toISOString(),
      last_push_at: null,
    });
    res.status(201).json({ success: true });
  });

  app.delete('/api/live-activities/token/:rideId/:activityId', async (req, res) => {
    const uid = await authenticatedUid(req, res);
    if (!uid) return;
    const rideId = cleanText(req.params.rideId, '', 160);
    const activityId = cleanText(req.params.activityId, '', 220);
    const ride = await adminFirestore.get(ADMIN_COLLECTIONS.RIDES, rideId);
    if (!ride || riderIdForRide(ride) !== uid) {
      res.status(404).json({ success: false, message: 'Live Activity not found.' });
      return;
    }
    await adminFirestore.set(LIVE_ACTIVITY_COLLECTION, activityDocumentId(rideId, activityId), {
      active: false,
      ended_at: new Date().toISOString(),
    });
    res.status(204).end();
  });
}

/** Sends a throttled remote ActivityKit update for one Rider trip. */
export async function sendRideLiveActivityUpdate(ride: Record<string, any>, options: { driverLocation?: Point; force?: boolean } = {}) {
  const rideId = cleanText(ride.id, '', 160);
  const riderId = riderIdForRide(ride);
  if (!rideId || !riderId) return { attempted: 0, sent: 0 };
  const activities = await adminFirestore.list(LIVE_ACTIVITY_COLLECTION, { ride_id: rideId, rider_id: riderId, active: true }, null, 'desc', 10);
  if (!activities.length) return { attempted: 0, sent: 0 };

  const now = Date.now();
  const deliverableActivities = activities.filter((activity) => {
    const lastPushAt = Date.parse(String(activity.last_push_at || ''));
    return options.force || !Number.isFinite(lastPushAt) || now - lastPushAt >= UPDATE_INTERVAL_MS || ['completed', 'cancelled'].includes(String(ride.status));
  });
  if (!deliverableActivities.length) return { attempted: activities.length, sent: 0 };
  const presentation = await liveActivityPresentation(ride, options.driverLocation || maybePoint(ride.driver?.location) || maybePoint(ride.driver_location) || undefined);
  let sent = 0;
  await Promise.all(deliverableActivities.map(async (activity) => {

    try {
      await getMessaging().send({
        token: String(activity.fcm_token),
        apns: {
          headers: {
            'apns-push-type': 'liveactivity',
            'apns-topic': 'com.hy3n.rider.push-type.liveactivity',
            'apns-priority': presentation.event === 'end' ? '10' : '5',
          },
          liveActivityToken: String(activity.activity_push_token),
          payload: {
            aps: {
              timestamp: Math.floor(now / 1000),
              event: presentation.event,
              'content-state': {
                title: presentation.title,
                subtitle: presentation.subtitle,
                timerEndDateInMilliseconds: presentation.arrivalAt,
                progress: presentation.progress,
                imageName: 'hy3n_car',
                dynamicIslandImageName: 'hy3n_car',
              },
              ...(presentation.event === 'end' ? { 'dismissal-date': Math.floor(now / 1000) + 15 * 60 } : {}),
            },
          },
        },
      });
      sent += 1;
      await adminFirestore.set(LIVE_ACTIVITY_COLLECTION, activity.id, {
        last_push_at: new Date(now).toISOString(),
        last_status: ride.status,
      });
      if (presentation.event === 'end') {
        await adminFirestore.set(LIVE_ACTIVITY_COLLECTION, activity.id, { active: false, ended_at: new Date(now).toISOString() });
      }
    } catch (error: any) {
      const code = String(error?.code || 'unknown');
      console.warn('[LiveActivity] Push update failed', { rideId, activityId: activity.id, code });
      if (code.includes('registration-token-not-registered') || code.includes('invalid-argument')) {
        await adminFirestore.set(LIVE_ACTIVITY_COLLECTION, activity.id, { active: false, invalidated_at: new Date(now).toISOString(), invalid_reason: code });
      }
    }
  }));
  return { attempted: activities.length, sent };
}

/** Emits a Driver GPS update to every active ride owned by that Driver. */
export async function sendDriverLocationLiveActivityUpdates(driverId: string, driverLocation: Point) {
  const statuses = ['matched', 'driver_arriving', 'driver_arrived', 'in_progress'];
  const rideGroups = await Promise.all(statuses.map((status) => adminFirestore.list(ADMIN_COLLECTIONS.RIDES, { driver_id: driverId, status }, null, 'desc', 3)));
  await Promise.all(rideGroups.flat().map((ride) => sendRideLiveActivityUpdate(ride, { driverLocation })));
}
