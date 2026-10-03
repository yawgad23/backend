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

export const driverLocationInput = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  heading: z.preprocess(normalizeUnknownIosHeading, z.number().finite().min(0).max(360).nullable().optional()),
  speedKmh: z.number().finite().min(0).max(240).nullable().optional(),
  recordedAt: z.string().datetime().optional(),
});

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

    const approvedProfile = await driverProfileForUserId(driverId);
    if (!isApprovedDriverProfile(approvedProfile)) {
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
    const recordedAt = input.recordedAt || new Date().toISOString();
    const location = {
      latitude: input.latitude,
      longitude: input.longitude,
      heading: input.heading ?? null,
      speedKmh: input.speedKmh ?? null,
      recorded_at: recordedAt,
    };
    const previousPresence = await adminFirestore.get('driver_presence', driverId);
    if (!shouldPersistDriverLocation(previousPresence, recordedAt)) {
      res.json({
        success: true,
        ignoredStaleLocation: true,
        location: previousPresence?.current_location || location,
      });
      return;
    }
    const patch = {
      user_id: driverId,
      current_location: location,
      latitude: input.latitude,
      longitude: input.longitude,
      last_location_update: recordedAt,
      last_seen_at: recordedAt,
    };

    // Keep the canonical approved profile and UID-keyed compatibility profile
    // in sync. `driverProfileForUserId` already queried legacy records, so do
    // not make a second sequential collection scan on every GPS sample.
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

    // Lock Screen refreshes are supplementary. They must not make the Driver
    // wait to go online, start a trip, or update a Rider-visible GPS marker.
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

    res.json({ success: true, location });
  });
}
