import { describe, expect, it } from 'vitest';
import { authorizeDriverRiderRating, riderRatingSummary } from './driverRiderRatings';

const completedRide = {
  id: 'ride-1',
  driver_id: 'driver-1',
  rider_id: 'rider-1',
  status: 'completed',
};

describe('Driver Rider rating authority', () => {
  it('allows only the matched Driver to rate the completed Rider once', () => {
    expect(authorizeDriverRiderRating(completedRide, 'driver-1', 'rider-1')).toEqual({ ok: true, riderId: 'rider-1' });
    expect(authorizeDriverRiderRating(completedRide, 'driver-2', 'rider-1')).toMatchObject({ ok: false, code: 'ride_not_matched' });
    expect(authorizeDriverRiderRating({ ...completedRide, driver_rating: 5 }, 'driver-1', 'rider-1')).toMatchObject({ ok: false, code: 'rating_already_submitted' });
  });

  it('excludes cancelled and malformed scores from the Rider rating count', () => {
    expect(riderRatingSummary([
      { status: 'completed', driver_rating: 5 },
      { status: 'completed', driver_rating: 3 },
      { status: 'completed', driver_rating: 7 },
      { status: 'cancelled', driver_rating: 1 },
    ])).toEqual({ average: 4, count: 2 });
  });
});
