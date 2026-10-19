import { describe, expect, it } from 'vitest';
import { normalizeAdminRideStatus } from './adminRideRoutes';

describe('Admin live ride status compatibility', () => {
  it('normalizes legacy assigned statuses to the assigned state', () => {
    expect(normalizeAdminRideStatus('accepted')).toBe('matched');
    expect(normalizeAdminRideStatus('assigned')).toBe('matched');
    expect(normalizeAdminRideStatus('driver-assigned')).toBe('matched');
  });

  it('preserves current operational states including queued assignments', () => {
    expect(normalizeAdminRideStatus('searching')).toBe('searching');
    expect(normalizeAdminRideStatus('driver_arriving')).toBe('driver_arriving');
    expect(normalizeAdminRideStatus('driver_queued')).toBe('driver_queued');
    expect(normalizeAdminRideStatus('in-progress')).toBe('in_progress');
  });
});
