import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import { adminFirestore, ADMIN_COLLECTIONS, getAdminAuth } from './firebaseAdmin';
import { sendDriverLocationLiveActivityUpdates } from './liveActivities';

const driverLocationInput = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  heading: z.number().finite().min(0).max(360).nullable().optional(),
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
    const patch = {
      user_id: driverId,
      current_location: location,
      latitude: input.latitude,
      longitude: input.longitude,
      last_location_update: recordedAt,
      last_seen_at: recordedAt,
    };

    // Keep the legacy approved-profile document and UID-keyed presence document
    // in sync. The Rider subscribes to the UID-keyed document for live updates.
    const canonical = await adminFirestore.get(ADMIN_COLLECTIONS.DRIVER_PROFILES, driverId);
    const profiles = await adminFirestore.list(ADMIN_COLLECTIONS.DRIVER_PROFILES, { user_id: driverId }, null, 'desc', 10);
    const targets = [...profiles, canonical]
      .filter((profile): profile is Record<string, any> => Boolean(profile))
      .filter((profile, index, list) => list.findIndex((other) => other.id === profile.id) === index);

    if (targets.length === 0) {
      await adminFirestore.set(ADMIN_COLLECTIONS.DRIVER_PROFILES, driverId, patch);
    } else {
      await Promise.all(targets.map((profile) => adminFirestore.set(ADMIN_COLLECTIONS.DRIVER_PROFILES, profile.id, patch)));
    }

    void sendDriverLocationLiveActivityUpdates(driverId, { latitude: input.latitude, longitude: input.longitude }).catch((error) => {
      // Location persistence remains successful even if Apple/FCM is delayed.
      console.error('[LiveActivity] Background Driver location push failed:', error);
    });

    res.json({ success: true, location });
  });
}
