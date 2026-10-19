import { driverLocationUpdatedAtMs, hasFreshDriverLocation } from './driverPresence';

export type AdminDriverLocation = {
  latitude: number;
  longitude: number;
  updated_at: string;
  is_fresh: true;
};

type PresenceReader = (driverId: string) => Promise<Record<string, any> | null>;

function validDriverId(value: unknown): string | null {
  const driverId = String(value || '').trim();
  return /^[A-Za-z0-9_-]{1,160}$/.test(driverId) ? driverId : null;
}

function finiteCoordinate(value: unknown, minimum: number, maximum: number): number | null {
  const coordinate = Number(value);
  return Number.isFinite(coordinate) && coordinate >= minimum && coordinate <= maximum
    ? coordinate
    : null;
}

/**
 * Produces the smallest operational location payload required by the protected
 * Admin map. Location freshness is based only on the authenticated server
 * receipt/heartbeat timestamp; `source_recorded_at` remains device ordering
 * data and is deliberately not exposed.
 */
export function adminDriverLocationProjection(
  presence: Record<string, any> | null | undefined,
  referenceMs = Date.now(),
): AdminDriverLocation | null {
  if (!presence || !hasFreshDriverLocation(presence, referenceMs)) return null;

  const location = presence.current_location;
  if (!location || typeof location !== 'object' || Array.isArray(location)) return null;

  const latitude = finiteCoordinate(location.latitude, -90, 90);
  const longitude = finiteCoordinate(location.longitude, -180, 180);
  const updatedAtMs = driverLocationUpdatedAtMs(presence);
  if (latitude === null || longitude === null || updatedAtMs === null) return null;

  return {
    latitude,
    longitude,
    updated_at: new Date(updatedAtMs).toISOString(),
    is_fresh: true,
  };
}

/**
 * Reads each currently assigned Driver presence document at most once. This is
 * intentionally only a server-side helper: the Admin browser receives the
 * sanitised projection, never a raw Driver profile or presence record.
 */
export async function freshAdminDriverLocations(
  driverIds: Iterable<unknown>,
  readPresence: PresenceReader,
  referenceMs = Date.now(),
): Promise<Map<string, AdminDriverLocation | null>> {
  const ids = [...new Set([...driverIds]
    .map(validDriverId)
    .filter((driverId): driverId is string => Boolean(driverId)))];

  const entries = await Promise.all(ids.map(async (driverId) => {
    const presence = await readPresence(driverId);
    return [driverId, adminDriverLocationProjection(presence, referenceMs)] as const;
  }));

  return new Map(entries);
}
