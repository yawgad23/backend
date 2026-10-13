import { RIDE_SEARCH_TTL_MS } from './rideSearchExpiry';

const asIdList = (value: unknown): string[] => Array.isArray(value)
  ? value.map((item) => String(item || '').trim()).filter(Boolean)
  : [];

/**
 * Re-opens the same pre-trip request after its assigned Driver cancels.
 *
 * It intentionally preserves the original server-locked quote, rider, route,
 * payment method, and audit history. It clears only the former Driver's
 * assignment and map/ETA details, then excludes that Driver from this request
 * so the offer can be sent to other eligible nearby Drivers.
 */
export function driverCancellationRedispatchPatch(input: {
  ride: Record<string, unknown>;
  driverId: string;
  reason: string;
  now?: Date;
  pickupCode: string;
}): Record<string, unknown> {
  const currentTime = input.now ?? new Date();
  const timestamp = currentTime.toISOString();
  const excludedDriverIds = [...new Set([...asIdList(input.ride.declined_by_driver_ids), input.driverId])];
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
    reassigned_after_driver_cancellation: true,
    driver_reassignment_count: reassignmentCount,
    last_driver_cancellation: {
      driver_id: input.driverId,
      reason: input.reason,
      at: timestamp,
    },
    last_driver_cancellation_at: timestamp,
    updated_date: timestamp,
  };
}
