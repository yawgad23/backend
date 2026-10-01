import { describe, expect, it } from 'vitest';
import { authorizeRiderDriverRating, driverRatingSummary } from './riderDriverRatings';

const completedRide = {
  id: 'ride-1',
  rider_id: 'rider-1',
  driver_id: 'driver-1',
  status: 'completed',
};

describe('Rider Driver rating authorization', () => {
  it('allows the authenticated Rider to rate a completed matched ride once', () => {
    expect(authorizeRiderDriverRating(completedRide, 'rider-1')).toEqual({ ok: true, driverId: 'driver-1' });
  });

  it('rejects other Riders, unfinished rides, and repeat ratings', () => {
    expect(authorizeRiderDriverRating(completedRide, 'rider-2')).toMatchObject({ ok: false, status: 403, code: 'ride_not_owned' });
    expect(authorizeRiderDriverRating({ ...completedRide, status: 'in_progress' }, 'rider-1')).toMatchObject({ ok: false, status: 409, code: 'ride_not_completed' });
    expect(authorizeRiderDriverRating({ ...completedRide, rider_rating: 5 }, 'rider-1')).toMatchObject({ ok: false, status: 409, code: 'rating_already_submitted' });
  });

  it('calculates ratings only from completed rides with valid Rider scores', () => {
    expect(driverRatingSummary([
      { status: 'completed', rider_rating: 5 },
      { status: 'completed', rider_rating: 4 },
      { status: 'completed', rider_rating: 9 },
      { status: 'cancelled', rider_rating: 1 },
    ])).toEqual({ average: 4.5, count: 2 });
  });
});
