import type { Express, Request, Response } from 'express';
import { adminFirestore, ADMIN_COLLECTIONS } from './firebaseAdmin';
import { requireAdministrator } from './adminAuthorization';
import { buildAdminTripDetail, rideParticipantIds } from './adminTripDetails';

const ACTIVE_STATUSES = new Set(['searching', 'matched', 'driver_arriving', 'driver_arrived', 'in_progress']);
const RECENT_STATUSES = new Set(['completed', 'cancelled']);

function rideTimestamp(ride: Record<string, any>): number {
  const value = ride.updated_date || ride.updated_at || ride.completed_at || ride.cancelled_at || ride.created_date || ride.created_at;
  if (value && typeof value === 'object' && typeof value.toDate === 'function') return value.toDate().getTime();
  const timestamp = new Date(String(value || '')).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

async function operationalRideRecords() {
  // Firestore excludes legacy records that lack a field used by `orderBy`.
  // Read the bounded server-only collection without an order, then sort the
  // normalized operational view in memory by its first available timestamp.
  const records = await adminFirestore.list(ADMIN_COLLECTIONS.RIDES, {}, null, 'desc', 1_000);
  return records.sort((left, right) => rideTimestamp(right) - rideTimestamp(left));
}

function coordinate(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= -90 && number <= 90 ? number : null;
}

function rideLocation(value: Record<string, any> | undefined) {
  const nested = value || {};
  const latitude = coordinate(nested.lat ?? nested.latitude ?? nested.latitude_degrees);
  const longitude = Number(nested.lng ?? nested.longitude ?? nested.longitude_degrees);
  if (latitude !== null && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180) {
    return { lat: latitude, lng: longitude };
  }
  return null;
}

function normalizedRide(ride: Record<string, any>) {
  const pickup = rideLocation(ride.pickup) || (() => {
    const lat = coordinate(ride.pickup_latitude ?? ride.pickup_lat);
    const lng = Number(ride.pickup_longitude ?? ride.pickup_lng);
    return lat !== null && Number.isFinite(lng) && lng >= -180 && lng <= 180 ? { lat, lng } : null;
  })();
  const destination = rideLocation(ride.destination) || (() => {
    const lat = coordinate(ride.destination_latitude ?? ride.dropoff_latitude ?? ride.destination_lat);
    const lng = Number(ride.destination_longitude ?? ride.dropoff_longitude ?? ride.destination_lng);
    return lat !== null && Number.isFinite(lng) && lng >= -180 && lng <= 180 ? { lat, lng } : null;
  })();

  return {
    id: String(ride.id),
    status: String(ride.status || '').toLowerCase().replace(/-/g, '_'),
    rider_name: String(ride.rider_name || ride.rider?.name || 'Rider'),
    driver_name: ride.driver_name || ride.driver?.name || null,
    vehicle_type: ride.vehicle_type || ride.category || null,
    fare: Number(ride.final_fare || ride.fare || ride.quoted_fare || 0) || null,
    payment_method: ride.payment_method || null,
    pickup,
    destination,
    pickup_address: ride.pickup?.address || ride.pickup_address || ride.pickup_location || null,
    destination_address: ride.destination?.address || ride.destination_address || ride.dropoff_location || null,
    created_date: ride.created_date || ride.created_at || null,
    updated_date: ride.updated_date || ride.updated_at || null,
  };
}

/** Read-only live operations feed for the protected HY3N administrator dashboard. */
export function registerAdminRideRoutes(app: Express) {
  /**
   * Privacy-minimized operational dossier for a single ride. The administrator
   * must supply both a Firebase identity and a server-issued access-code proof;
   * Rider/Driver profile data is never placed in the list or map endpoints.
   */
  app.get('/api/admin/rides/:rideId/details', async (request: Request, response: Response) => {
    const adminEmail = await requireAdministrator(request, response);
    if (!adminEmail) return;

    const rideId = String(request.params.rideId || '').trim();
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(rideId)) {
      response.status(400).json({ error: 'Trip reference is invalid.' });
      return;
    }

    try {
      const ride = await adminFirestore.get(ADMIN_COLLECTIONS.RIDES, rideId);
      if (!ride) {
        response.status(404).json({ error: 'Trip not found.' });
        return;
      }

      const { riderId, driverId } = rideParticipantIds(ride);
      const [riderProfile, driverProfile] = await Promise.all([
        riderId ? adminFirestore.get(ADMIN_COLLECTIONS.RIDER_PROFILES, riderId) : Promise.resolve(null),
        driverId ? adminFirestore.get(ADMIN_COLLECTIONS.DRIVER_PROFILES, driverId) : Promise.resolve(null),
      ]);

      response.json(buildAdminTripDetail(ride, riderProfile, driverProfile));
    } catch (error) {
      console.error('[Admin ride details] Failed to load protected trip dossier:', error);
      response.status(503).json({ error: 'Trip details are temporarily unavailable. Please refresh.' });
    }
  });

  app.get('/api/admin/rides/live', async (request: Request, response: Response) => {
    const adminEmail = await requireAdministrator(request, response);
    if (!adminEmail) return;
    try {
      const records = await operationalRideRecords();
      const rides = records.map(normalizedRide);
      response.json({
        active: rides.filter((ride) => ACTIVE_STATUSES.has(ride.status)),
        recent: rides.filter((ride) => RECENT_STATUSES.has(ride.status)).slice(0, 50),
      });
    } catch (error) {
      console.error('[Admin rides] Failed to load live rides:', error);
      response.status(503).json({ error: 'Live rides are temporarily unavailable. Please refresh.' });
    }
  });
}
