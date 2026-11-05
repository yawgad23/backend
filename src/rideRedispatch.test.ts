import { describe, expect, it } from 'vitest';
import { assignmentReleaseRedispatchPatch, shouldDispatchNextDriverAfterRideUpdate, shouldRedispatchAssignedRide } from './rideRedispatch';

describe('Assignment-release ride re-dispatch', () => {
  it('returns the same pre-trip request to searching and excludes the former Driver', () => {
    const now = new Date('2026-10-13T23:45:00.000Z');
    const patch = assignmentReleaseRedispatchPatch({
      ride: {
        status: 'driver_arriving',
        driver_id: 'driver-old',
        declined_by_driver_ids: ['driver-earlier'],
        driver_reassignment_count: 1,
        fare: 25,
        quoted_fare: 25,
      },
      previousDriverId: 'driver-old',
      releasedBy: 'driver',
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
      reassigned_after_assignment_release: true,
      reassigned_after_driver_cancellation: true,
      assignment_release_actor: 'driver',
      driver_reassignment_count: 2,
      declined_by_driver_ids: ['driver-earlier', 'driver-old'],
      search_expires_at: '2026-10-13T23:51:00.000Z',
    });
    expect(patch).not.toHaveProperty('fare');
    expect(patch).not.toHaveProperty('quoted_fare');
  });

  it('keeps the same protected ride when the Rider asks for another Driver', () => {
    const patch = assignmentReleaseRedispatchPatch({
      ride: { declined_by_driver_ids: ['driver-1'], fare: 29, quote_id: 'quote-locked' },
      previousDriverId: 'driver-1',
      releasedBy: 'rider',
      reason: 'Driver is taking too long',
      now: new Date('2026-10-13T23:45:00.000Z'),
      pickupCode: '1048',
    });

    expect(patch).toMatchObject({
      status: 'searching',
      assignment_release_actor: 'rider',
      reassigned_after_assignment_release: true,
      reassigned_after_driver_cancellation: false,
      declined_by_driver_ids: ['driver-1'],
    });
    expect(patch).not.toHaveProperty('fare');
    expect(patch).not.toHaveProperty('quote_id');
  });

  it('allows re-dispatch only for the explicit Find another ride action before Start Trip', () => {
    expect(shouldRedispatchAssignedRide(
      { status: 'driver_arriving', driver_id: 'driver-1' },
      true,
    )).toBe(true);
    expect(shouldRedispatchAssignedRide(
      { status: 'searching', driver_id: null },
      true,
    )).toBe(false);
    expect(shouldRedispatchAssignedRide(
      { status: 'in_progress', driver_id: 'driver-1' },
      true,
    )).toBe(false);
    expect(shouldRedispatchAssignedRide(
      { status: 'driver_arriving', driver_id: 'driver-1' },
      false,
    )).toBe(false);
  });
});

describe('automatic next-driver dispatch after ride updates', () => {
  it('dispatches immediately when an accepted Driver cancels before starting the trip', () => {
    const before = {
      status: 'driver_arriving',
      driver_id: 'driver-1',
      offered_driver_id: null,
    };
    const after = {
      status: 'searching',
      driver_id: null,
      offered_driver_id: null,
      reassigned_after_assignment_release: true,
      reassigned_after_driver_cancellation: true,
      assignment_release_actor: 'driver',
      last_assignment_release_at: '2026-11-05T14:00:00.000Z',
    };
    expect(shouldDispatchNextDriverAfterRideUpdate(before, after)).toBe(true);
  });

  it('continues to dispatch after an explicit decline of a targeted offer', () => {
    expect(shouldDispatchNextDriverAfterRideUpdate(
      { status: 'searching', driver_id: null, offered_driver_id: 'driver-1' },
      { status: 'searching', driver_id: null, offered_driver_id: null },
    )).toBe(true);
  });

  it('does not dispatch again for unrelated updates after a reassignment', () => {
    const ride = {
      status: 'searching',
      driver_id: null,
      offered_driver_id: 'driver-2',
      reassigned_after_assignment_release: true,
      assignment_release_actor: 'driver',
      last_assignment_release_at: '2026-11-05T14:00:00.000Z',
    };
    expect(shouldDispatchNextDriverAfterRideUpdate(ride, {
      ...ride,
      updated_date: '2026-11-05T14:00:05.000Z',
    })).toBe(false);
  });

  it('does not dispatch when a ride is already accepted or has started', () => {
    expect(shouldDispatchNextDriverAfterRideUpdate(
      { status: 'searching', driver_id: null },
      { status: 'driver_arriving', driver_id: 'driver-2' },
    )).toBe(false);
    expect(shouldDispatchNextDriverAfterRideUpdate(
      { status: 'in_progress', driver_id: 'driver-1' },
      { status: 'searching', driver_id: null, reassigned_after_assignment_release: true },
    )).toBe(false);
  });
});
