import { RIDE_SEARCH_TTL_MS } from './rideSearchExpiry';

const asIdList = (value: unknown): string[] => Array.isArray(value)
  ? value.map((item) => String(item || '').trim()).filter(Boolean)
  : [];

/** A Rider can re-dispatch only an assigned, not-yet-started ride. */
export function shouldRedispatchAssignedRide(
  ride: Record<string, unknown>,
  requested: unknown,
): boolean {
  const status = String(ride.status || '').trim().toLowerCase();
  const driverId = String(ride.driver_id || '').trim();
  return requested === true
    && Boolean(driverId)
    && ['matched', 'driver_arriving', 'driver_arrived', 'driver_queued'].includes(status);
}

/**
 * Re-opens the same pre-trip request when the current Driver assignment must
 * be released. The server retains the original locked quote, route, payment,
 * and Rider identity; it clears only the old Driver assignment and excludes
 * that Driver from receiving this request again.
 */
export function assignmentReleaseRedispatchPatch(input: {
  ride: Record<string, unknown>;
  previousDriverId: string;
  releasedBy: 'rider' | 'driver';
  reason: string;
  now?: Date;
  pickupCode: string;
}): Record<string, unknown> {
  const currentTime = input.now ?? new Date();
  const timestamp = currentTime.toISOString();
  const priorDriverId = String(input.previousDriverId || '').trim();
  const excludedDriverIds = [...new Set([
    ...asIdList(input.ride.declined_by_driver_ids),
    ...(priorDriverId ? [priorDriverId] : []),
  ])];
  const reassignmentCount = Math.max(0, Math.floor(Number(input.ride.driver_reassignment_count) || 0)) + 1;

  return {
    status: 'searching',
    search_expires_at: new Date(currentTime.getTime() + RIDE_SEARCH_TTL_MS).toISOString(),
    driver_id: null,
    driver: null,
    driver_name: null,
    driver_vehicle: null,
    driver_vehicle_make: null,
    driver_vehicle_model: null,
    driver_service_type: null,
    driver_plate: null,
    driver_colour: null,
    driver_colour_hex: null,
    driver_photo: null,
    driver_phone: null,
    driver_momo_number: null,
    driver_momo_network: null,
    driver_location: null,
    driver_location_updated_at: null,
    live_route_metrics: null,
    eta_minutes: null,
    eta_seconds: null,
    matched_at: null,
    accepted_at: null,
    driver_arrived_at: null,
    pickup_verified_at: null,
    queued_after_ride_id: null,
    pickup_code: input.pickupCode,
    ride_pin: input.pickupCode,
    declined_by_driver_ids: excludedDriverIds,
    reassigned_after_assignment_release: true,
    reassigned_after_driver_cancellation: input.releasedBy === 'driver',
    assignment_release_actor: input.releasedBy,
    driver_reassignment_count: reassignmentCount,
    last_assignment_release: {
      actor: input.releasedBy,
      driver_id: priorDriverId || null,
      reason: input.reason,
      at: timestamp,
    },
    last_assignment_release_at: timestamp,
    updated_date: timestamp,
  };
}

/**
 * Detects the two server transitions that must advance an open ride search:
 * an explicit decline of a targeted offer, or release of an accepted/pre-trip
 * driver assignment. The release timestamp prevents later offer bookkeeping
 * updates from recursively dispatching the same ride.
 */
export function shouldDispatchNextDriverAfterRideUpdate(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): boolean {
  const stillSearching = String(after.status || '').trim().toLowerCase() === 'searching'
    && !String(after.driver_id || '').trim();
  if (!stillSearching) return false;

  const wasTargeted = Boolean(String(before.offered_driver_id || '').trim());
  const isTargeted = Boolean(String(after.offered_driver_id || '').trim());
  const explicitDeclineOrTimeout = wasTargeted && !isTargeted;

  const releaseAt = String(after.last_assignment_release_at || '').trim();
  const previousReleaseAt = String(before.last_assignment_release_at || '').trim();
  const assignmentReleased = after.reassigned_after_assignment_release === true
    && Boolean(String(before.driver_id || '').trim())
    && !String(after.driver_id || '').trim()
    && Boolean(releaseAt)
    && releaseAt !== previousReleaseAt
    && ['driver', 'rider'].includes(String(after.assignment_release_actor || '').trim().toLowerCase());

  return explicitDeclineOrTimeout || assignmentReleased;
}
