import { describe, expect, it } from 'vitest';
import { riderOwnsRideStatus } from './riderRideStatus';

describe('Rider ride status authorization', () => {
  it('permits only the authoritative rider id', () => {
    expect(riderOwnsRideStatus({ rider_id: 'rider-1' }, 'rider-1')).toBe(true);
    expect(riderOwnsRideStatus({ rider_id: 'rider-1' }, 'rider-2')).toBe(false);
  });

  it('supports legacy riderId records without exposing unknown rides', () => {
    expect(riderOwnsRideStatus({ riderId: 'rider-1' }, 'rider-1')).toBe(true);
    expect(riderOwnsRideStatus(null, 'rider-1')).toBe(false);
    expect(riderOwnsRideStatus({}, 'rider-1')).toBe(false);
  });
});
