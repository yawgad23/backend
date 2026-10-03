export type RiderRideStatusRecord = {
  rider_id?: unknown;
  riderId?: unknown;
};

/** A status read is private to the Rider who owns the ride. */
export function riderOwnsRideStatus(ride: RiderRideStatusRecord | null | undefined, riderId: string): boolean {
  if (!ride || !riderId) return false;
  const owner = String(ride.rider_id ?? ride.riderId ?? '').trim();
  return Boolean(owner) && owner === riderId;
}
