export type RiderDriverRatingDecision =
  | { ok: true; driverId: string }
  | { ok: false; status: 403 | 404 | 409; code: string; message: string };

type RideRecord = Record<string, unknown>;

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function completed(value: unknown): boolean {
  return text(value).toLowerCase() === 'completed';
}

function hasRating(value: unknown): boolean {
  const rating = Number(value);
  return Number.isInteger(rating) && rating >= 1 && rating <= 5;
}

/**
 * Authorizes the one Rider-to-Driver rating allowed for a completed ride.
 * The authenticated UID is authoritative; no client-supplied Rider or Driver
 * identifier is accepted.
 */
export function authorizeRiderDriverRating(
  ride: RideRecord | null | undefined,
  authenticatedRiderId: string,
): RiderDriverRatingDecision {
  if (!ride) {
    return { ok: false, status: 404, code: 'ride_not_found', message: 'Ride not found.' };
  }

  const riderId = text(ride.rider_id ?? ride.riderId ?? ride.user_id ?? (ride.rider as RideRecord | undefined)?.id);
  if (!riderId || riderId !== text(authenticatedRiderId)) {
    return { ok: false, status: 403, code: 'ride_not_owned', message: 'You can only rate a Driver from your own completed ride.' };
  }

  if (!completed(ride.status)) {
    return { ok: false, status: 409, code: 'ride_not_completed', message: 'Complete the ride before rating your Driver.' };
  }

  const driverId = text(ride.driver_id ?? ride.driverId ?? (ride.driver as RideRecord | undefined)?.id);
  if (!driverId) {
    return { ok: false, status: 409, code: 'driver_missing', message: 'This completed ride has no Driver available to rate.' };
  }

  if (hasRating(ride.rider_rating)) {
    return { ok: false, status: 409, code: 'rating_already_submitted', message: 'You have already rated this Driver for this ride.' };
  }

  return { ok: true, driverId };
}

export function driverRatingSummary(rides: RideRecord[]): { average: number; count: number } {
  const ratings = rides
    .filter((ride) => completed(ride.status))
    .map((ride) => Number(ride.rider_rating))
    .filter((rating) => Number.isInteger(rating) && rating >= 1 && rating <= 5);

  const count = ratings.length;
  return {
    count,
    average: count === 0 ? 0 : Number((ratings.reduce((sum, rating) => sum + rating, 0) / count).toFixed(2)),
  };
}
