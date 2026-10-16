import crypto from 'crypto';
import type { Express, Request, Response } from 'express';
import { getMessaging } from 'firebase-admin/messaging';
import { z } from 'zod';
import { ADMIN_COLLECTIONS, adminFirestore, getAdminAuth } from './firebaseAdmin';

const LIVE_ACTIVITY_COLLECTION = 'rider_live_activities';
// Driver GPS can arrive more often than a Lock Screen needs to redraw. Send a
// position change promptly but keep a slower safety refresh to respect the
// system's ActivityKit notification budget.
const MOVEMENT_UPDATE_INTERVAL_MS = 20_000;
const FULL_REFRESH_INTERVAL_MS = 45_000;
const MEANINGFUL_PROGRESS_DELTA = 0.003;
const MAX_ACTIVE_TRIP_PROGRESS = 0.98;
export const HY3N_LIVE_ACTIVITY_IMAGE_NAME = 'hy3n_trip_car';
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

function finiteNonNegative(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
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

function latestLiveRoute(ride: Record<string, any>) {
  const route = ride.live_route_metrics && typeof ride.live_route_metrics === 'object'
    ? ride.live_route_metrics as Record<string, unknown>
    : {};
  return {
    distanceKm: finiteNonNegative(route.distance_km),
    durationMinutes: finiteNonNegative(route.duration_minutes),
    phase: cleanText(route.phase, '', 40),
  };
}

/**
 * Display-only route progress. The backend derives it from the server quote
 * distance and live server road distance; it does not read a client meter and
 * never changes fares, wallets, Driver earnings, or ride settlement.
 */
export function liveActivityTripProgress(input: {
  status?: unknown;
  quotedDistanceKm?: unknown;
  remainingDistanceKm?: unknown;
  previousProgress?: unknown;
}) {
  const previous = Math.min(MAX_ACTIVE_TRIP_PROGRESS, Math.max(0, finiteNonNegative(input.previousProgress) ?? 0));
  if (String(input.status) !== 'in_progress') return 0;

  const total = finiteNonNegative(input.quotedDistanceKm);
  const remaining = finiteNonNegative(input.remainingDistanceKm);
  if (total === null || total <= 0 || remaining === null) return previous;

  const measured = Math.min(MAX_ACTIVE_TRIP_PROGRESS, Math.max(0, 1 - (remaining / total)));
  return Math.max(previous, measured);
}

export function shouldDeliverLiveActivityUpdate(input: {
  lastPushAt?: unknown;
  now?: number;
  force?: boolean;
  previousProgress?: unknown;
  nextProgress?: unknown;
}) {
  if (input.force) return true;
  const now = input.now ?? Date.now();
  const lastPushAt = Date.parse(String(input.lastPushAt || ''));
  if (!Number.isFinite(lastPushAt)) return true;
  const elapsed = Math.max(0, now - lastPushAt);
  if (elapsed >= FULL_REFRESH_INTERVAL_MS) return true;

  const previous = finiteNonNegative(input.previousProgress) ?? 0;
  const next = finiteNonNegative(input.nextProgress) ?? 0;
  return elapsed >= MOVEMENT_UPDATE_INTERVAL_MS && next - previous >= MEANINGFUL_PROGRESS_DELTA;
}

export function liveActivityPushPriority(input: {
  force?: boolean;
  previousProgress?: unknown;
  nextProgress?: unknown;
}) {
  const previous = finiteNonNegative(input.previousProgress) ?? 0;
  const next = finiteNonNegative(input.nextProgress) ?? 0;
  // Apple permits priority 10 for updates that need quick delivery. Reserve it
  // for an explicit state change or real Driver route movement; periodic ETA
  // refreshes stay at 5 so the activity is not throttled.
  return input.force || next - previous >= MEANINGFUL_PROGRESS_DELTA ? '10' : '5';
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

export async function liveActivityPresentation(
  ride: Record<string, any>,
  driverLocation?: Point,
  previousProgress = 0,
) {
  const status = cleanText(ride.status, 'driver_arriving', 40);
  const onTrip = status === 'in_progress';
  const completed = status === 'completed' || status === 'cancelled';
  const destinationName = cleanText(ride.destination?.name || ride.destination?.address || ride.destination_name, 'your destination', 80);
  const pickupName = cleanText(ride.pickup?.name || ride.pickup?.address || ride.pickup_name, 'your pickup point', 80);
  const driverName = cleanText(ride.driver?.name || ride.driver_name, 'Your HY3N driver', 60);
  const vehicle = cleanText(ride.driver_vehicle || `${ride.driver_vehicle_make || ''} ${ride.driver_vehicle_model || ''}`, '', 70);

  // Ending an activity must never wait on external route calculation. It is
  // sent synchronously by the completion handler so an old trip cannot remain
  // on the Rider's Lock Screen after the Driver has finished it.
  if (completed) {
    return {
      event: 'end' as ActivityEvent,
      title: status === 'completed' ? 'Trip complete' : 'Ride cancelled',
      subtitle: status === 'completed' ? 'Thank you for riding with HY3N' : 'Open HY3N to book another ride',
      arrivalAt: null as number | null,
      progress: 1,
    };
  }

  const target = onTrip ? maybePoint(ride.destination) : maybePoint(ride.pickup);
  const fallbackMinutes = onTrip
    ? Number(ride.estimated_duration_minutes ?? ride.duration ?? 12)
    : Number(ride.eta_minutes ?? 5);
  const directKm = driverLocation && target ? distanceKm(driverLocation, target) : NaN;
  const routeKm = Number.isFinite(directKm) ? directKm * 1.23 : NaN;
  const speedKmh = onTrip ? 22 : 18;
  const freshRoad = await roadRouteMetrics(driverLocation, target || undefined);
  const storedRoute = latestLiveRoute(ride);
  const remainingDistanceKm = freshRoad?.distanceKm ?? storedRoute.distanceKm;
  const remainingDurationMinutes = freshRoad?.durationMinutes ?? storedRoute.durationMinutes;
  const etaMinutes = remainingDurationMinutes !== null && remainingDurationMinutes !== undefined
    ? Math.max(1, Math.ceil(remainingDurationMinutes))
    : Number.isFinite(routeKm)
      ? Math.max(1, Math.ceil((routeKm / speedKmh) * 60))
      : Math.max(1, Math.ceil(Number.isFinite(fallbackMinutes) ? fallbackMinutes : 5));
  const bookedDistanceKm = Number(ride.estimated_distance_km ?? ride.distance_km ?? ride.distance);
  const routeProgress = liveActivityTripProgress({
    status,
    quotedDistanceKm: bookedDistanceKm,
    remainingDistanceKm: onTrip && storedRoute.phase && storedRoute.phase !== 'destination'
      ? undefined
      : remainingDistanceKm,
    previousProgress,
  });
  const arrivalAt = Date.now() + etaMinutes * 60_000;
  if (status === 'driver_arrived') {
    return {
      event: 'update' as ActivityEvent,
      title: 'Your driver has arrived',
      subtitle: `Meet ${driverName} at ${pickupName}`,
      arrivalAt: Date.now() + 60_000,
      progress: 0,
    };
  }
  if (onTrip) {
    return {
      event: 'update' as ActivityEvent,
      title: `Drop-off at ${formatAccraTime(arrivalAt)}`,
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
    progress: 0,
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
      last_progress: 0,
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
  const candidateActivities = activities.filter((activity) => {
    const lastPushAt = Date.parse(String(activity.last_push_at || ''));
    return options.force
      || ['completed', 'cancelled'].includes(String(ride.status))
      || !Number.isFinite(lastPushAt)
      || now - lastPushAt >= MOVEMENT_UPDATE_INTERVAL_MS;
  });
  if (!candidateActivities.length) return { attempted: activities.length, sent: 0 };

  let sent = 0;
  await Promise.all(candidateActivities.map(async (activity) => {
    const presentation = await liveActivityPresentation(
      ride,
      options.driverLocation || maybePoint(ride.driver?.location) || maybePoint(ride.driver_location) || undefined,
      Number(activity.last_progress || 0),
    );
    const mustDeliver = options.force || presentation.event === 'end';
    if (!shouldDeliverLiveActivityUpdate({
      lastPushAt: activity.last_push_at,
      now,
      force: mustDeliver,
      previousProgress: activity.last_progress,
      nextProgress: presentation.progress,
    })) return;
    const priority = presentation.event === 'end'
      ? '10'
      : liveActivityPushPriority({
        force: options.force,
        previousProgress: activity.last_progress,
        nextProgress: presentation.progress,
      });

    try {
      await getMessaging().send({
        token: String(activity.fcm_token),
        apns: {
          headers: {
            'apns-push-type': 'liveactivity',
            'apns-topic': 'com.hy3n.rider.push-type.liveactivity',
            'apns-priority': priority,
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
                ...(presentation.event === 'end' ? {} : {
                  imageName: HY3N_LIVE_ACTIVITY_IMAGE_NAME,
                  dynamicIslandImageName: HY3N_LIVE_ACTIVITY_IMAGE_NAME,
                }),
              },
              // Briefly confirm the final state, then remove the Lock Screen
              // card instead of leaving an old destination visible.
              ...(presentation.event === 'end' ? { 'dismissal-date': Math.floor(now / 1000) + 30 } : {}),
              // Let iOS mark the display stale if connection loss prevents the
              // next Driver movement update from arriving.
              ...(presentation.event === 'end' ? {} : { 'stale-date': Math.floor(now / 1000) + 120 }),
            },
          },
        },
      });
      sent += 1;
      await adminFirestore.set(LIVE_ACTIVITY_COLLECTION, activity.id, {
        last_push_at: new Date(now).toISOString(),
        last_status: ride.status,
        last_progress: presentation.progress,
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
