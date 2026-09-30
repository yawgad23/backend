import { describe, expect, it } from 'vitest';
import { completedTripCountAfterCompletion, driverTripCountProfilePatch } from './driverTripCounts';

describe('authoritative Driver trip counts', () => {
  it('counts completed rides only and includes the one server-confirmed completion', () => {
    const total = completedTripCountAfterCompletion([
      { id: 'ride-older-completed', driver_id: 'driver-1', status: 'completed' },
      { id: 'ride-cancelled', driver_id: 'driver-1', status: 'cancelled' },
      { id: 'ride-other-driver', driver_id: 'driver-2', status: 'completed' },
      { id: 'ride-current', driver_id: 'driver-1', status: 'in_progress' },
    ], 'driver-1', 'ride-current');

    expect(total).toBe(2);
  });

  it('does not double-count a ride that is already in the historical list', () => {
    const total = completedTripCountAfterCompletion([
      { id: 'ride-current', driver_id: 'driver-1', status: 'completed' },
      { id: 'ride-older-completed', driver_id: 'driver-1', status: 'completed' },
    ], 'driver-1', 'ride-current');

    expect(total).toBe(2);
  });

  it('builds one safe profile patch for canonical and retained profiles', () => {
    expect(driverTripCountProfilePatch('driver-1', 2.9, '2026-09-30T22:00:00.000Z')).toEqual({
      user_id: 'driver-1',
      total_trips: 2,
      total_rides: 2,
      total_trips_updated_at: '2026-09-30T22:00:00.000Z',
      total_trips_source: 'completed_ride_records',
    });
  });
});
