import { driverApprovalState, isApprovedDriverProfile } from './driverApproval';

export const DRIVER_LOCATION_FRESHNESS_MS = 3 * 60 * 1000;

const CATEGORY_ALIASES: Record<string, string> = {
  economy: 'standard',
  premium: 'comfort',
  delivery: 'express_delivery',
};

function presenceRideCategories(profile: Record<string, any> | null | undefined): string[] {
  if (!profile) return ['standard'];
  const configured = Array.isArray(profile.ride_categories)
    ? profile.ride_categories
    : Array.isArray(profile.accepted_categories)
      ? profile.accepted_categories
      : [];
  const normalized = configured
    .map((value: unknown) => CATEGORY_ALIASES[String(value || '').trim().toLowerCase()] || String(value || '').trim().toLowerCase())
    .filter(Boolean);
  if (normalized.length) return [...new Set(normalized)];

  const serviceType = String(profile.service_type || profile.serviceType || '').toLowerCase();
  if (serviceType.includes('deliver')) return ['express_delivery'];
  if (serviceType.includes('okada') || serviceType.includes('moto')) return ['okada'];
  return ['standard'];
}

/**
 * Only server-selected operational metadata belongs in the public presence
 * document. Rider maps need these fields to apply the same approval/category
 * rules as dispatch, while contact, identity, and payment data remain private.
 */
export function mapSafeDriverPresenceMetadata(profile: Record<string, any> | null | undefined) {
  const approved = isApprovedDriverProfile(profile);
  return {
    approval_status: approved ? 'approved' : driverApprovalState(profile),
    approved,
    is_approved: approved,
    ride_categories: presenceRideCategories(profile),
  };
}

function timestampToMilliseconds(value: unknown): number | null {
  if (typeof value === 'string' || typeof value === 'number' || value instanceof Date) {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (!value || typeof value !== 'object') return null;
  const timestamp = value as {
    toMillis?: () => number;
    seconds?: number;
    _seconds?: number;
    nanoseconds?: number;
    _nanoseconds?: number;
  };
  if (typeof timestamp.toMillis === 'function') {
    const parsed = timestamp.toMillis();
    return Number.isFinite(parsed) ? parsed : null;
  }

  const seconds = Number(timestamp.seconds ?? timestamp._seconds);
  if (!Number.isFinite(seconds)) return null;
  const nanos = Number(timestamp.nanoseconds ?? timestamp._nanoseconds ?? 0);
  return seconds * 1000 + (Number.isFinite(nanos) ? nanos / 1_000_000 : 0);
}

export function driverLocationUpdatedAtMs(profile: Record<string, any> | null | undefined): number | null {
  if (!profile) return null;
  const location = profile.current_location || profile.location || {};
  return timestampToMilliseconds(
    location.recorded_at
      ?? profile.last_location_update
      ?? profile.last_seen_at
      ?? profile.last_seen,
  );
}

/**
 * A Driver only appears as live when the device recently published GPS. This
 * prevents an old marker from surviving an app force-close or lost connection.
 */
export function hasFreshDriverLocation(
  profile: Record<string, any> | null | undefined,
  referenceMs = Date.now(),
): boolean {
  const updatedAtMs = driverLocationUpdatedAtMs(profile);
  if (updatedAtMs === null) return false;
  // Allow a small clock skew, but reject impossible future timestamps.
  if (updatedAtMs > referenceMs + 60_000) return false;
  return referenceMs - updatedAtMs <= DRIVER_LOCATION_FRESHNESS_MS;
}

export function isOnlineWithFreshLocation(
  profile: Record<string, any> | null | undefined,
  referenceMs = Date.now(),
): boolean {
  if (!profile) return false;
  const availability = String(profile.availability_status || '').toLowerCase();
  const markedOnline = profile.is_online === true || availability === 'online';
  return markedOnline && availability !== 'offline' && availability !== 'busy'
    && hasFreshDriverLocation(profile, referenceMs);
}

export function profilePresencePatch(status: 'online' | 'offline' | 'busy') {
  const isOnline = status === 'online';
  return {
    availability_status: status,
    is_online: isOnline,
    is_available: isOnline,
    last_seen_at: new Date().toISOString(),
  };
}
