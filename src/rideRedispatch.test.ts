import { describe, expect, it } from 'vitest';
import { driverCancellationRedispatchPatch } from './rideRedispatch';

describe('Driver-cancelled ride re-dispatch', () => {
  it('returns the same pre-trip request to searching and excludes the former Driver', () => {
    const now = new Date('2026-10-13T23:45:00.000Z');
    const patch = driverCancellationRedispatchPatch({
      ride: {
        status: 'driver_arriving',
        driver_id: 'driver-old',
        declined_by_driver_ids: ['driver-earlier'],
        driver_reassignment_count: 1,
        fare: 25,
        quoted_fare: 25,
      },
      driverId: 'driver-old',
      reason: 'Vehicle issue',
      now,
      pickupCode: '5821',
    });

    expect(patch).toMatchObject({
      status: 'searching',
      driver_id: null,
      driver: null,
      pickup_code: '5821',
      ride_pin: '5821',
      reassigned_after_driver_cancellation: true,
      driver_reassignment_count: 2,
      declined_by_driver_ids: ['driver-earlier', 'driver-old'],
      search_expires_at: '2026-10-13T23:51:00.000Z',
    });
    expect(patch).not.toHaveProperty('fare');
    expect(patch).not.toHaveProperty('quoted_fare');
  });

  it('does not duplicate a Driver exclusion across repeated guarded attempts', () => {
    const patch = driverCancellationRedispatchPatch({
      ride: { declined_by_driver_ids: ['driver-1'] },
      driverId: 'driver-1',
      reason: 'Unable to continue',
      now: new Date('2026-10-13T23:45:00.000Z'),
      pickupCode: '1048',
    });

    expect(patch.declined_by_driver_ids).toEqual(['driver-1']);
  });
});
