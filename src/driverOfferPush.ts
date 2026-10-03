import { ADMIN_COLLECTIONS, adminFirestore } from './firebaseAdmin';
import { driverCanServeRideCategory } from './driverRouters';
import { isOnlineWithFreshLocation } from './driverPresence';
import { isExpoPushToken } from './pushNotifications';

const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';
const MAX_DRIVER_OFFER_RECIPIENTS = 12;

type DriverPresence = Record<string, unknown> & {
  id: string;
  user_id?: unknown;
  current_location?: unknown;
  location?: unknown;
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
 * Selects only fresh, category-compatible Drivers from minimal presence data.
 * The authoritative accept endpoint still rechecks approval, availability,
 * platform-fee eligibility and atomic ride assignment before a ride is matched.
 */
export function driverOfferRecipients(ride: Record<string, unknown>, presences: DriverPresence[], now = Date.now()): string[] {
  return presences
    .filter((presence) => isOnlineWithFreshLocation(presence as Record<string, any>, now))
    .filter((presence) => driverCanServeRideCategory(presence as Record<string, any>, ride.category))
    .map((presence) => ({
      uid: cleanText(presence.user_id ?? presence.id),
      distanceKm: pickupDistanceKm(ride, presence),
      radiusKm: configuredPickupRadiusKm(presence),
    }))
    .filter((candidate) => candidate.uid && candidate.distanceKm !== null && candidate.distanceKm <= candidate.radiusKm)
    .sort((left, right) => Number(left.distanceKm) - Number(right.distanceKm))
    .slice(0, MAX_DRIVER_OFFER_RECIPIENTS)
    .map((candidate) => candidate.uid);
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

  try {
    const presences = await adminFirestore.list('driver_presence', {}, null, 'desc', 500) as DriverPresence[];
    const recipientIds = driverOfferRecipients(rawRide, presences);
    if (recipientIds.length === 0) return { attempted: 0, sent: 0 };

    const deviceReads = await Promise.all(recipientIds.map((uid) => (
      adminFirestore.list(ADMIN_COLLECTIONS.PUSH_DEVICES, { uid }, null, 'desc', 20)
    )));
    const devices = deviceReads
      .flat()
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
