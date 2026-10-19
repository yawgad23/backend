import { describe, expect, it } from 'vitest';
import { isAdminLiveRide, normalizeAdminRideStatus } from './adminRideRoutes';

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

  it('does not count an expired waiting request as live', () => {
    const now = Date.parse('2026-10-19T19:30:00.000Z');
    expect(isAdminLiveRide({ status: 'searching', search_expires_at: '2026-10-19T19:24:00.000Z' }, now)).toBe(false);
    expect(isAdminLiveRide({ status: 'searching', search_expires_at: '2026-10-19T19:35:00.000Z' }, now)).toBe(true);
  });

  it('does not count a terminal history record that retained an active status', () => {
    expect(isAdminLiveRide({ status: 'in_progress', completed_at: '2026-10-19T19:20:00.000Z' })).toBe(false);
    expect(isAdminLiveRide({ status: 'driver_arriving', cancelled_at: '2026-10-19T19:20:00.000Z' })).toBe(false);
    expect(isAdminLiveRide({ status: 'in_progress', driver_id: 'driver-1', trip_started_at: '2026-10-19T19:20:00.000Z' })).toBe(true);
  });

  it('rejects incomplete active-looking legacy records without lifecycle evidence', () => {
    expect(isAdminLiveRide({ status: 'searching' })).toBe(false);
    expect(isAdminLiveRide({ status: 'in_progress', driver_id: 'driver-1' })).toBe(false);
    expect(isAdminLiveRide({ status: 'driver_arriving' })).toBe(false);
  });

  it('accepts a genuinely active started ride with server timestamps and Driver assignment', () => {
    expect(isAdminLiveRide({
      status: 'in_progress',
      driver_id: 'driver-1',
      trip_started_at: '2026-10-19T19:30:00.000Z',
    })).toBe(true);
  });
});
