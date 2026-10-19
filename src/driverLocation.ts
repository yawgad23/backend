import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import { adminFirestore, ADMIN_COLLECTIONS, getAdminAuth } from './firebaseAdmin';
import { sendDriverLocationLiveActivityUpdates } from './liveActivities';
import { refreshDriverActiveRideRoutes } from './liveRouteMetrics';
import { driverProfileForUserId, isApprovedDriverProfile } from './driverApproval';
import { mapSafeDriverPresenceMetadata } from './driverPresence';
import { shouldPersistDriverLocation } from './driverLocationOrdering';

/**
 * Core Location uses -1 for an unknown compass heading. A Driver can be
 * stationary while going online, so this is valid location metadata rather
 * than a malformed GPS point. Treat it as an absent optional heading.
 */
export function normalizeUnknownIosHeading(value: unknown): unknown {
  return Number(value) === -1 ? null : value;
}

/**
 * A device location timestamp orders coordinate samples, but it cannot decide
 * whether a live authenticated Driver app is still connected. iOS can reuse a
 * valid cached Core Location timestamp for several foreground heartbeats. Keep
 * the two concepts separate: `sourceRecordedAt` prevents a late coordinate
 * replay from moving the map backwards and `receivedAt` keeps a live Driver
 * eligible for availability and offers.
 */
export function driverLocationTimestamps(inputRecordedAt?: string, receivedAt = new Date().toISOString()) {
  return {
    sourceRecordedAt: inputRecordedAt || receivedAt,
    receivedAt,
  };
}

/** Keep a verified online Driver available without accepting an older coordinate. */
export function availabilityHeartbeatLocation(previous: Record<string, any> | null | undefined, receivedAt: string) {
  const existing = previous?.current_location && typeof previous.current_location === 'object'
    ? previous.current_location
    : {};
  return {
    ...existing,
    // The coordinate stays unchanged; this is a verified app heartbeat, not a
    // second GPS sample. The source timestamp remains for coordinate ordering.
    recorded_at: receivedAt,
  };
}

export const driverLocationInput = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  heading: z.preprocess(normalizeUnknownIosHeading, z.number().finite().min(0).max(360).nullable().optional()),
  speedKmh: z.number().finite().min(0).max(240).nullable().optional(),
  recordedAt: z.string().datetime().optional(),
});

const ACTIVE_LEGACY_LOCATION_STATUSES = new Set([
  'matched',
  'driver_arriving',
  'driver_arrived',
  'in_progress',
]);

/**
 * Narrow compatibility for a legacy trip that is already server-assigned to
 * the authenticated Firebase account. It deliberately grants neither Driver
 * approval nor online/offer eligibility; it only keeps that one active trip's
 * live GPS and route refresh working while its missing profile is repaired.
 */
export function canPublishActiveLegacyRideLocation(ride: Record<string, unknown> | null | undefined, driverId: string): boolean {
  if (!ride || !driverId) return false;
  return ACTIVE_LEGACY_LOCATION_STATUSES.has(String(ride.status || '').trim().toLowerCase())
    && String(ride.driver_id || '').trim() === driverId;
}

async function hasActiveLegacyRideForDriver(driverId: string): Promise<boolean> {
  const rides = (await Promise.all(
    [...ACTIVE_LEGACY_LOCATION_STATUSES].map((status) => (
      adminFirestore.list(ADMIN_COLLECTIONS.RIDES, { driver_id: driverId, status }, null, 'desc', 1)
    )),
  )).flat();
  return rides.some((ride) => canPublishActiveLegacyRideLocation(ride, driverId));
}

export function activeLegacyLocationPresencePatch(
  driverId: string,
  location: Record<string, unknown>,
  receivedAt: string,
) {
  return {
    user_id: driverId,
    current_location: location,
    latitude: location.latitude,
    longitude: location.longitude,
    last_location_update: receivedAt,
    last_seen_at: receivedAt,
    // This document exists only to stream the already-assigned ride. It must
    // not make a missing-profile account selectable for a new request.
    legacy_active_trip_location_only: true,
    availability_status: 'busy',
    is_online: false,
    is_available: false,
    approved: false,
    is_approved: false,
  };
}

/**
 * A Rider may already read their own active ride, so project only the assigned
 * Driver's minimal live map point there. This replaces the need for any Rider
 * client to read the general Driver presence collection.
 */
export function activeRideDriverLocationPatch(
  ride: Record<string, unknown> | null | undefined,
  driverId: string,
  location: Record<string, unknown>,
  receivedAt: string,
): Record<string, unknown> | null {
  if (!canPublishActiveLegacyRideLocation(ride, driverId)) return null;
  const heading = location.heading === null || location.heading === undefined
    ? null
    : Number(location.heading);
  return {
    driver_location: {
      latitude: Number(location.latitude),
      longitude: Number(location.longitude),
      heading: Number.isFinite(heading) ? heading : null,
      recorded_at: receivedAt,
      source_recorded_at: String(location.source_recorded_at || receivedAt),
    },
    driver_location_updated_at: receivedAt,
  };
}

async function projectActiveRideDriverLocation(
  driverId: string,
  location: Record<string, unknown>,
  receivedAt: string,
) {
  const rides = (await Promise.all(
    [...ACTIVE_LEGACY_LOCATION_STATUSES].map((status) => (
      adminFirestore.list(ADMIN_COLLECTIONS.RIDES, { driver_id: driverId, status }, null, 'desc', 3)
    )),
  )).flat();
  const writes = rides.map(async (ride) => {
    const patch = activeRideDriverLocationPatch(ride, driverId, location, receivedAt);
    if (!patch || !ride.id) return false;
    await adminFirestore.update(ADMIN_COLLECTIONS.RIDES, String(ride.id), patch);
    return true;
  });
  const results = await Promise.all(writes);
  return { updated: results.filter(Boolean).length };
}

async function authenticatedDriverId(req: Request, res: Response): Promise<string | null> {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!match) {
    res.status(401).json({ success: false, message: 'Please sign in before sharing your location.' });
    return null;
  }

  try {
    return (await getAdminAuth().verifyIdToken(match[1])).uid;
  } catch {
    res.status(401).json({ success: false, message: 'Your session has expired. Please sign in again.' });
    return null;
  }
}

/**
 * Authenticated location ingress used by foreground and iOS background Driver
 * location updates. A Firebase ID token establishes the Driver ID; callers can
 * never select another Driver profile in the request body.
 */
export function registerDriverLocationRoutes(app: Express) {
  app.post('/api/driver/location', async (req, res) => {
    const driverId = await authenticatedDriverId(req, res);
    if (!driverId) return;

    const driverProfile = await driverProfileForUserId(driverId);
    const approvedProfile = isApprovedDriverProfile(driverProfile) ? driverProfile : null;
    // Only a completely missing profile can use the compatibility path. A
    // pending, rejected, suspended, or inactive Driver application continues
    // to be blocked exactly as before.
    const activeLegacyRideOnly = !driverProfile && await hasActiveLegacyRideForDriver(driverId);
    if (!approvedProfile && !activeLegacyRideOnly) {
      res.status(403).json({
        success: false,
        message: 'Your Driver application must be approved by HY3N before location sharing can be enabled.',
      });
      return;
    }

    const parsed = driverLocationInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, message: 'Invalid driver location.' });
      return;
    }

    const input = parsed.data;
    const { sourceRecordedAt, receivedAt } = driverLocationTimestamps(input.recordedAt);
    const location = {
      latitude: input.latitude,
      longitude: input.longitude,
      heading: input.heading ?? null,
      speedKmh: input.speedKmh ?? null,
      // Rider freshness is based on authenticated server receipt time. The
      // source timestamp remains stored below for monotonic coordinate order.
      recorded_at: receivedAt,
      source_recorded_at: sourceRecordedAt,
    };
    const previousPresence = await adminFirestore.get('driver_presence', driverId);
    if (!shouldPersistDriverLocation(previousPresence, sourceRecordedAt)) {
      const heartbeatLocation = availabilityHeartbeatLocation(previousPresence, receivedAt);
      const heartbeatPatch = activeLegacyRideOnly
        ? activeLegacyLocationPresencePatch(driverId, heartbeatLocation, receivedAt)
        : {
        user_id: driverId,
        current_location: heartbeatLocation,
        last_location_update: receivedAt,
        last_seen_at: receivedAt,
      };
      if (activeLegacyRideOnly) {
        await adminFirestore.set('driver_presence', driverId, heartbeatPatch);
      } else {
        const canonical = approvedProfile;
        const profileIds = new Set([driverId, ...(canonical?.id ? [String(canonical.id)] : [])]);
        await Promise.all([
          ...[...profileIds].map((profileId) => adminFirestore.set(ADMIN_COLLECTIONS.DRIVER_PROFILES, profileId, heartbeatPatch)),
          adminFirestore.set('driver_presence', driverId, heartbeatPatch),
        ]);
      }
      // A late coordinate must not move a Rider map backwards, but a verified
      // application heartbeat may refresh the same assigned-trip marker.
      void projectActiveRideDriverLocation(driverId, heartbeatLocation, receivedAt).catch((error) => {
        console.error('[RideLocation] Active ride heartbeat projection failed:', error);
      });
      res.json({
        success: true,
        ignoredStaleLocation: true,
        location: heartbeatLocation,
      });
      return;
    }
    const patch = {
      user_id: driverId,
      current_location: location,
      latitude: input.latitude,
      longitude: input.longitude,
      last_location_update: receivedAt,
      last_seen_at: receivedAt,
    };

    // Keep the canonical approved profile and UID-keyed compatibility profile
    // in sync. `driverProfileForUserId` already queried legacy records, so do
    // not make a second sequential collection scan on every GPS sample.
    if (activeLegacyRideOnly) {
      // Do not create a blank Driver profile as a side effect. The existing
      // active Rider may receive this presence stream, but dispatch still sees
      // a busy/non-approved account and cannot send another offer.
      await adminFirestore.set('driver_presence', driverId, activeLegacyLocationPresencePatch(driverId, location, receivedAt));
    } else {
      const canonical = approvedProfile;
      const profileIds = new Set([driverId, ...(canonical?.id ? [String(canonical.id)] : [])]);

      // Rider maps use a deliberately minimal record. Full Driver profile and
      // application data remain private to the Driver and the admin dashboard.
      await Promise.all([
        ...[...profileIds].map((profileId) => adminFirestore.set(ADMIN_COLLECTIONS.DRIVER_PROFILES, profileId, patch)),
        adminFirestore.set('driver_presence', driverId, {
        service_type: approvedProfile?.service_type || approvedProfile?.serviceType || 'car',
        vehicle_type: approvedProfile?.vehicle_type || approvedProfile?.vehicleType || 'car',
        vehicle_make: approvedProfile?.vehicle_make || approvedProfile?.vehicleMake || '',
        vehicle_model: approvedProfile?.vehicle_model || approvedProfile?.vehicleModel || '',
        vehicle_color: approvedProfile?.vehicle_color || approvedProfile?.vehicle_colour || '',
        vehicle_colour: approvedProfile?.vehicle_colour || approvedProfile?.vehicle_color || '',
        vehicle_colour_hex: approvedProfile?.vehicle_colour_hex || '',
        license_plate: approvedProfile?.license_plate || approvedProfile?.vehicle_plate || '',
        vehicle_plate: approvedProfile?.vehicle_plate || approvedProfile?.license_plate || '',
        rating: Number(approvedProfile?.rating || 0),
        ...mapSafeDriverPresenceMetadata({ ...approvedProfile, ...patch }),
        ...patch,
        }),
      ]);
    }

    // Lock Screen refreshes are supplementary. They must not make the Driver
    // wait to go online, start a trip, or update a Rider-visible GPS marker.
    void projectActiveRideDriverLocation(driverId, location, receivedAt).catch((error) => {
      console.error('[RideLocation] Active ride projection failed:', error);
    });
    void sendDriverLocationLiveActivityUpdates(driverId, { latitude: input.latitude, longitude: input.longitude }).catch((error) => {
      console.error('[LiveActivity] Background Driver location push failed:', error);
    });

    // Route metrics are server-owned and refreshed independently of the
    // presence write. A routing outage must never reject a valid GPS update.
    void refreshDriverActiveRideRoutes(driverId, {
      latitude: input.latitude,
      longitude: input.longitude,
    }).catch((error) => {
      console.error('[RoadRoute] Driver route refresh failed:', error);
    });

    res.json({ success: true, location, activeLegacyRideOnly });
  });
}
