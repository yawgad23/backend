export type DriverTripRecord = Record<string, unknown>;

function normalized(value: unknown): string {
  return String(value || '').trim();
}

/**
 * Counts only completed rides assigned to the supplied Driver. The ride record,
 * not a client profile field, is the authority for a Driver's lifetime count.
 */
export function completedTripCountAfterCompletion(
  rides: DriverTripRecord[],
  driverId: string,
  completingRideId: string,
): number {
  const normalizedDriverId = normalized(driverId);
  if (!normalizedDriverId) return 0;

  const historicalCompleted = rides.filter((ride) => {
    if (normalized(ride.id) === normalized(completingRideId)) return false;
    if (normalized(ride.driver_id ?? ride.driverId) !== normalizedDriverId) return false;
    return normalized(ride.status).toLowerCase() === 'completed';
  }).length;

  // The caller has atomically verified that completingRideId is still
  // in_progress, so it becomes exactly one completed trip in this transition.
  return historicalCompleted + 1;
}

/**
 * The completion path must not scan a Driver's entire ride history before it
 * acknowledges End Trip. The server-owned profile counter is updated in the
 * same Firestore transaction as the terminal ride state, so the next count is
 * authoritative for normal operation and cannot be supplied by a client.
 */
export function nextCompletedTripCount(profileRecords: DriverTripRecord[]): number {
  const current = profileRecords.reduce((maximum, profile) => {
    const count = Number(profile.total_trips ?? profile.total_rides ?? 0);
    return Number.isFinite(count) && count >= 0 ? Math.max(maximum, Math.floor(count)) : maximum;
  }, 0);
  return current + 1;
}

/** Canonical and legacy Driver profile documents receive the same derived count. */
export function driverTripCountProfilePatch(driverId: string, totalTrips: number, updatedAt: string) {
  const safeTotal = Math.max(0, Math.floor(Number(totalTrips) || 0));
  return {
    user_id: driverId,
    total_trips: safeTotal,
    total_rides: safeTotal,
    total_trips_updated_at: updatedAt,
    total_trips_source: 'server_completion_counter',
  };
}
