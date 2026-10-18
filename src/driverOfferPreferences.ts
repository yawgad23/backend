import { z } from 'zod';
import { ADMIN_COLLECTIONS, adminFirestore } from './firebaseAdmin';
import { driverProfileForUserId } from './driverApproval';

export const DRIVER_LONG_TRIP_MINIMUM_KM = 10;
export const DRIVER_HIGH_RATED_RIDER_MINIMUM = 4.5;

export const driverOfferPreferencesInput = z.object({
  notifications: z.boolean(),
  soundAlerts: z.boolean(),
  autoAccept: z.boolean(),
  longTripsOnly: z.boolean(),
  preferHighRated: z.boolean(),
  destinationFilter: z.string().trim().max(160).nullable(),
});

export type DriverOfferPreferences = z.infer<typeof driverOfferPreferencesInput>;

export const DEFAULT_DRIVER_OFFER_PREFERENCES: DriverOfferPreferences = {
  notifications: true,
  soundAlerts: true,
  autoAccept: false,
  longTripsOnly: false,
  preferHighRated: true,
  destinationFilter: null,
};

function booleanValue(value: unknown, fallback: boolean) {
  return typeof value === 'boolean' ? value : fallback;
}

export function normalizeDriverOfferPreferences(value: unknown): DriverOfferPreferences {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    notifications: booleanValue(raw.notifications, true),
    soundAlerts: booleanValue(raw.soundAlerts, true),
    autoAccept: booleanValue(raw.autoAccept, false),
    longTripsOnly: booleanValue(raw.longTripsOnly, false),
    preferHighRated: booleanValue(raw.preferHighRated, true),
    destinationFilter: typeof raw.destinationFilter === 'string' && raw.destinationFilter.trim()
      ? raw.destinationFilter.trim().slice(0, 160)
      : null,
  };
}

export function preferencesForDriverRecord(record: Record<string, unknown> | null | undefined) {
  const nested = record?.preferences ?? record?.driver_preferences;
  return normalizeDriverOfferPreferences(nested);
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function offerDistanceKm(ride: Record<string, unknown>): number | null {
  return finiteNumber(ride.distance_km ?? ride.estimated_distance_km ?? ride.route_distance_km ?? ride.distance);
}

export function riderRating(ride: Record<string, unknown>): number | null {
  const value = finiteNumber(ride.rider_rating);
  const count = finiteNumber(ride.rider_rating_count);
  return value !== null && value >= 1 && value <= 5 && (count === null || count > 0) ? value : null;
}

/** A long-trip-only Driver is never reserved an offer at or below 10 km. */
export function driverAllowsRideByDistance(ride: Record<string, unknown>, preferences: DriverOfferPreferences): boolean {
  if (!preferences.longTripsOnly) return true;
  const distanceKm = offerDistanceKm(ride);
  return distanceKm !== null && distanceKm > DRIVER_LONG_TRIP_MINIMUM_KM;
}

/**
 * High-rated preference ranks an opted-in Driver first for a verified 4.5+
 * Rider. A neutral Driver is the next fallback; an opted-in Driver is last for
 * an un-rated/lower-rated Rider. No score is manufactured from missing data.
 */
export function driverOfferPreferencePriority(ride: Record<string, unknown>, preferences: DriverOfferPreferences): number {
  if (!preferences.preferHighRated) return 1;
  const rating = riderRating(ride);
  return rating !== null && rating >= DRIVER_HIGH_RATED_RIDER_MINIMUM ? 0 : 2;
}

/**
 * Writes both legacy/current profile shapes and the minimal presence record.
 * Dispatch reads presence; it contains no identity, fare, payment, or trip data.
 */
export async function saveDriverOfferPreferences(driverId: string, preferences: DriverOfferPreferences) {
  const profile = await driverProfileForUserId(driverId);
  if (!profile?.id) throw new Error('Driver profile not found.');
  const normalized = normalizeDriverOfferPreferences(preferences);
  const patch = { user_id: driverId, preferences: normalized, driver_preferences: normalized };
  const ids = new Set([driverId, String(profile.id)]);
  await Promise.all([
    ...[...ids].map((id) => adminFirestore.set(ADMIN_COLLECTIONS.DRIVER_PROFILES, id, patch)),
    adminFirestore.set('driver_presence', driverId, { user_id: driverId, driver_preferences: normalized }),
  ]);
  return normalized;
}
