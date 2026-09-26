import type { Express, Request, Response } from 'express';
import { adminFirestore, ADMIN_COLLECTIONS } from './firebaseAdmin';
import { requireAdministrator } from './adminAuthorization';

const ACTIVE_STATUSES = new Set(['searching', 'matched', 'driver_arriving', 'driver_arrived', 'in_progress']);
const RECENT_STATUSES = new Set(['completed', 'cancelled']);

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
    status: String(ride.status || '').toLowerCase(),
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
  app.get('/api/admin/rides/live', async (request: Request, response: Response) => {
    const adminEmail = await requireAdministrator(request, response);
    if (!adminEmail) return;
    try {
      const records = await adminFirestore.list(ADMIN_COLLECTIONS.RIDES, {}, 'updated_date', 'desc', 500);
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
