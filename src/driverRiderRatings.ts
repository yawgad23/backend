export type DriverRiderRatingDecision =
  | { ok: true; riderId: string }
  | { ok: false; code: string; message: string };

type RideRecord = Record<string, unknown>;

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function completed(value: unknown): boolean {
  return text(value).toLowerCase() === 'completed';
}

function validRating(value: unknown): boolean {
  const rating = Number(value);
  return Number.isInteger(rating) && rating >= 1 && rating <= 5;
}

/** Authorizes one authenticated Driver rating for the Rider in a completed trip. */
export function authorizeDriverRiderRating(
  ride: RideRecord | null | undefined,
  authenticatedDriverId: string,
  claimedRiderId: string,
): DriverRiderRatingDecision {
  if (!ride) return { ok: false, code: 'ride_not_found', message: 'Ride not found.' };

  const driverId = text(ride.driver_id ?? ride.driverId ?? (ride.driver as RideRecord | undefined)?.id);
  const riderId = text(ride.rider_id ?? ride.riderId ?? (ride.rider as RideRecord | undefined)?.id);
  if (!driverId || driverId !== text(authenticatedDriverId) || !riderId || riderId !== text(claimedRiderId)) {
    return { ok: false, code: 'ride_not_matched', message: 'This ride is not eligible for rating.' };
  }
  if (!completed(ride.status)) return { ok: false, code: 'ride_not_completed', message: 'Complete the ride before submitting a rating.' };
  if (validRating(ride.driver_rating)) {
    return { ok: false, code: 'rating_already_submitted', message: 'You have already rated this Rider for this trip.' };
  }
  return { ok: true, riderId };
}

/** Summarizes only valid Driver ratings of Riders from completed rides. */
export function riderRatingSummary(rides: RideRecord[]): { average: number; count: number } {
  const ratings = rides
    .filter((ride) => completed(ride.status))
    .map((ride) => Number(ride.driver_rating))
    .filter((rating) => Number.isInteger(rating) && rating >= 1 && rating <= 5);
  const count = ratings.length;
  return {
    count,
    average: count === 0 ? 0 : Number((ratings.reduce((sum, rating) => sum + rating, 0) / count).toFixed(2)),
  };
}
