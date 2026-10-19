import { ADMIN_COLLECTIONS, adminFirestore } from './firebaseAdmin';
import { driverCanServeRideCategory } from './driverRouters';
import { isOnlineWithFreshLocation } from './driverPresence';
import { isExpoPushToken } from './pushNotifications';
import { excludedDriverIdsForOffer } from './rideOfferLifecycle';
import {
  driverAllowsRideByDistance,
  driverOfferPreferencePriority,
  preferencesForDriverRecord,
} from './driverOfferPreferences';
import { driverProfileForUserId } from './driverApproval';

const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';
const MAX_DRIVER_OFFER_CANDIDATES = 24;
const VEHICLE_COLOUR_HEX: Record<string, string> = {
  black: '#1A1A1A', white: '#F5F5F5', silver: '#C0C0C0', grey: '#808080',
  red: '#CE1126', blue: '#1D4ED8', green: '#006B3F', gold: '#D4AF37',
  brown: '#92400E', orange: '#EA580C', maroon: '#7F1D1D', yellow: '#FBBF24',
};

export type DriverPresence = Record<string, unknown> & {
  id: string;
  user_id?: unknown;
  current_location?: unknown;
  location?: unknown;
};

export type DriverOfferCandidate = {
  driverId: string;
  latitude: number;
  longitude: number;
  heading?: number | null;
  serviceType?: 'car' | 'okada' | 'delivery';
  vehicleColourHex?: string | null;
};

type PushDevice = Record<string, unknown> & {
  id: string;
  uid?: unknown;
  role?: unknown;
  token?: unknown;
  active?: unknown;
};

function cleanText(value: unknown, fallback = ''): string {
  if (typeof value !== 'string' && typeof value !== 'number') return fallback;
  const result = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return result || fallback;
}

function locationOf(record: Record<string, unknown>): { lat: number; lng: number } | null {
  const location = record.current_location && typeof record.current_location === 'object'
    ? record.current_location as Record<string, unknown>
    : record.location && typeof record.location === 'object'
      ? record.location as Record<string, unknown>
      : record;
  const lat = Number(location.latitude ?? location.lat ?? record.latitude);
  const lng = Number(location.longitude ?? location.lng ?? record.longitude);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function vehicleServiceType(record: Record<string, unknown>): DriverOfferCandidate['serviceType'] {
  const value = cleanText(record.service_type ?? record.serviceType).toLowerCase();
  if (value.includes('deliver')) return 'delivery';
  if (value.includes('okada') || value.includes('moto') || value.includes('bike')) return 'okada';
  return 'car';
}

function displayHeading(record: Record<string, unknown>): number | null {
  const location = record.current_location && typeof record.current_location === 'object'
    ? record.current_location as Record<string, unknown>
    : record.location && typeof record.location === 'object'
      ? record.location as Record<string, unknown>
      : record;
  const heading = Number(location.heading ?? record.heading);
  return Number.isFinite(heading) ? heading : null;
}

function displayVehicleColour(record: Record<string, unknown>): string | null {
  const colour = cleanText(record.vehicle_colour_hex ?? record.vehicle_color_hex);
  if (/^#[0-9a-f]{6}$/i.test(colour)) return colour;
  const namedColour = cleanText(record.vehicle_colour ?? record.vehicle_color).toLowerCase();
  return VEHICLE_COLOUR_HEX[namedColour] ?? null;
}

function pickupDistanceKm(ride: Record<string, unknown>, driver: DriverPresence): number | null {
  const pickup = ride.pickup && typeof ride.pickup === 'object' ? ride.pickup as Record<string, unknown> : {};
  const pickupLat = Number(pickup.lat ?? pickup.latitude);
  const pickupLng = Number(pickup.lng ?? pickup.longitude);
  const driverLocation = locationOf(driver);
  if (!driverLocation || !Number.isFinite(pickupLat) || !Number.isFinite(pickupLng)) return null;
  const latitudeKm = (driverLocation.lat - pickupLat) * 111;
  const longitudeKm = (driverLocation.lng - pickupLng) * 111 * Math.cos(pickupLat * Math.PI / 180);
  return Math.hypot(latitudeKm, longitudeKm);
}

function configuredPickupRadiusKm(driver: DriverPresence): number {
  const preferences = driver.driver_preferences && typeof driver.driver_preferences === 'object'
    ? driver.driver_preferences as Record<string, unknown>
    : {};
  const configured = Number(preferences.pickupRadiusKm ?? driver.pickup_radius_km ?? 10);
  return Number.isFinite(configured) ? Math.min(100, Math.max(1, configured)) : 10;
}

/**
 * Builds the exact ordered presence candidates used before dispatch's fee gate.
 * This is server-only data: consumers must project identifiers and coordinates
 * away before returning any response to a Rider.
 */
export function driverOfferCandidates(
  ride: Record<string, unknown>,
  presences: DriverPresence[],
  now = Date.now(),
  maximum = 1,
): DriverOfferCandidate[] {
  const excludedDriverIds = new Set(excludedDriverIdsForOffer(ride));
  return presences
    .filter((presence) => isOnlineWithFreshLocation(presence as Record<string, any>, now))
    .filter((presence) => driverCanServeRideCategory(presence as Record<string, any>, ride.category))
    .filter((presence) => !excludedDriverIds.has(cleanText(presence.user_id ?? presence.id)))
    .map((presence) => {
      const location = locationOf(presence);
      return {
        driverId: cleanText(presence.user_id ?? presence.id),
        distanceKm: pickupDistanceKm(ride, presence),
        radiusKm: configuredPickupRadiusKm(presence),
        preferences: preferencesForDriverRecord(presence),
        latitude: location?.lat ?? Number.NaN,
        longitude: location?.lng ?? Number.NaN,
        heading: displayHeading(presence),
        serviceType: vehicleServiceType(presence),
        vehicleColourHex: displayVehicleColour(presence),
      };
    })
    .filter((candidate) => candidate.driverId && candidate.distanceKm !== null && candidate.distanceKm <= candidate.radiusKm)
    .filter((candidate) => Number.isFinite(candidate.latitude) && Number.isFinite(candidate.longitude))
    .filter((candidate) => driverAllowsRideByDistance(ride, candidate.preferences))
    .map((candidate) => ({ ...candidate, preferencePriority: driverOfferPreferencePriority(ride, candidate.preferences) }))
    .sort((left, right) => left.preferencePriority - right.preferencePriority || Number(left.distanceKm) - Number(right.distanceKm))
    .slice(0, Math.max(1, Math.min(MAX_DRIVER_OFFER_CANDIDATES, Math.floor(maximum) || 1)))
    .map(({ driverId, latitude, longitude, heading, serviceType, vehicleColourHex }) => ({
      driverId, latitude, longitude, heading, serviceType, vehicleColourHex,
    }));
}

/**
 * Ranks fresh, category-compatible Drivers from minimal presence data. The
 * dispatcher reserves only the first fee-eligible candidate; the downstream
 * push sender delivers only to that persisted single recipient.
 */
export function driverOfferRecipients(
  ride: Record<string, unknown>,
  presences: DriverPresence[],
  now = Date.now(),
  maximum = 1,
): string[] {
  return driverOfferCandidates(ride, presences, now, maximum).map((candidate) => candidate.driverId);
}

/** A disabled push switch suppresses only device wake-ups, never offer eligibility. */
export function driverOfferPushNotificationsEnabled(profile: Record<string, unknown> | null | undefined) {
  return preferencesForDriverRecord(profile).notifications;
}

/**
 * Sends a privacy-safe wake-up to nearby Drivers immediately after a server
 * creates a searching ride. The existing authenticated polling query remains
 * the source of full offer details and a safe fallback if a device is offline.
 */
export async function sendDriverRideOfferPush(rideId: string, rawRide: Record<string, unknown>) {
  if (!rideId || cleanText(rawRide.status).toLowerCase() !== 'searching' || cleanText(rawRide.driver_id)) {
    return { attempted: 0, sent: 0 };
  }

  const offeredDriverId = cleanText(rawRide.offered_driver_id);
  if (!offeredDriverId) return { attempted: 0, sent: 0 };

  try {
    const profile = await driverProfileForUserId(offeredDriverId);
    if (!driverOfferPushNotificationsEnabled(profile)) return { attempted: 0, sent: 0 };
    const devices = (await adminFirestore.list(ADMIN_COLLECTIONS.PUSH_DEVICES, { uid: offeredDriverId }, null, 'desc', 20))
      .filter((device): device is PushDevice => (
        cleanText(device.role).toLowerCase() === 'driver'
        && device.active === true
        && isExpoPushToken(cleanText(device.token))
      ));
    if (devices.length === 0) return { attempted: 0, sent: 0 };

    const category = cleanText(rawRide.category, 'ride').replace(/_/g, ' ');
    const payload = devices.map((device) => ({
      to: cleanText(device.token),
      title: `New ${category} ride request`,
      body: 'Open HY3N Driver to review and accept this nearby trip.',
      sound: 'default',
      priority: 'high',
      channelId: 'rides',
      data: { type: 'ride_offer', rideId },
    }));
    const response = await fetch(EXPO_PUSH_ENDPOINT, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({})) as { data?: Array<{ status?: string }> };
    const sent = response.ok && Array.isArray(body.data)
      ? body.data.filter((ticket) => ticket?.status === 'ok').length
      : 0;
    console.info('[Push] Driver ride-offer dispatch complete', { rideId, attempted: devices.length, sent });
    return { attempted: devices.length, sent };
  } catch (error) {
    console.error('[Push] Driver ride-offer dispatch failed', { rideId, error });
    return { attempted: 0, sent: 0 };
  }
}
