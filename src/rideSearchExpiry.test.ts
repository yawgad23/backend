import { describe, expect, it } from 'vitest';
import {
  RIDE_SEARCH_TTL_MS,
  expiredRideSearchPatch,
  isRideSearchExpired,
  rideSearchExpiresAt,
} from './rideSearchExpiry';

describe('ride search expiry', () => {
  const requestedAt = Date.parse('2026-09-26T12:00:00.000Z');

  it('expires a searching request after the six-minute window', () => {
    const ride = { status: 'searching', created_at: new Date(requestedAt).toISOString() };
    expect(rideSearchExpiresAt(ride)).toBe(requestedAt + RIDE_SEARCH_TTL_MS);
    expect(isRideSearchExpired(ride, requestedAt + RIDE_SEARCH_TTL_MS - 1)).toBe(false);
    expect(isRideSearchExpired(ride, requestedAt + RIDE_SEARCH_TTL_MS)).toBe(true);
  });

  it('honours an explicit server expiry and never expires a matched ride', () => {
    const expiry = new Date(requestedAt + 60_000).toISOString();
    expect(isRideSearchExpired({ status: 'searching', search_expires_at: expiry }, requestedAt + 60_000)).toBe(true);
    expect(isRideSearchExpired({ status: 'matched', search_expires_at: expiry }, requestedAt + 60_000)).toBe(false);
  });

  it('creates an auditable terminal cancellation patch', () => {
    expect(expiredRideSearchPatch(new Date('2026-09-26T12:06:00.000Z'))).toMatchObject({
      status: 'cancelled',
      cancelled_by: 'system',
      cancelled_at: '2026-09-26T12:06:00.000Z',
    });
  });
});
