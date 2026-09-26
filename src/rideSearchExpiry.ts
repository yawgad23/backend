/** A Rider search is no longer valid after the same six-minute window shown in the app. */
export const RIDE_SEARCH_TTL_MS = 6 * 60 * 1000;

function parseMillis(value: unknown): number | null {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function rideSearchExpiresAt(ride: Record<string, any>): number | null {
  const explicitExpiry = parseMillis(ride.search_expires_at);
  if (explicitExpiry !== null) return explicitExpiry;

  const createdAt = parseMillis(ride.created_at ?? ride.created_date ?? ride.date);
  return createdAt === null ? null : createdAt + RIDE_SEARCH_TTL_MS;
}

export function isRideSearchExpired(ride: Record<string, any>, currentTime = Date.now()): boolean {
  if (String(ride.status || '').trim().toLowerCase() !== 'searching') return false;
  const expiresAt = rideSearchExpiresAt(ride);
  return expiresAt !== null && currentTime >= expiresAt;
}

export function expiredRideSearchPatch(currentTime = new Date()): Record<string, string> {
  const cancelledAt = currentTime.toISOString();
  return {
    status: 'cancelled',
    cancelled_by: 'system',
    cancellation_reason: 'Search expired: no driver accepted within 6 minutes',
    cancelled_at: cancelledAt,
    search_expired_at: cancelledAt,
  };
}
