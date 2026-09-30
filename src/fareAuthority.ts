import {
  getDefaultFareRate,
  normalizeFareCategory,
  normalizeFareRate,
  type FareRate,
} from './fareConfig';

export type RideFareFields = Record<string, unknown>;
export type { FareRate } from './fareConfig';

export type MeteredFareBreakdown = {
  category: string;
  baseFare: number;
  distanceKm: number;
  distanceRate: number;
  distanceFare: number;
  durationMinutes: number;
  timeRate: number;
  timeFare: number;
  surgeMultiplier: number;
  minimumFare: number;
  bookingFee: number;
  waitingFee: number;
  total: number;
};

export const FREE_WAITING_MINUTES = 3;

export type WaitingCharge = {
  waitedMinutes: number;
  chargeableMinutes: number;
  ratePerMinute: number;
  waitingFee: number;
};

function finiteNonNegative(value: unknown, fallback = 0): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : fallback;
}

/** HY3N display rule: fractions at .50 or below round down; above .50 round up. */
export function roundGhsFare(value: unknown): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return 0;
  const whole = Math.floor(amount);
  return whole + (amount - whole > 0.5 ? 1 : 0);
}

/** The rate snapshot is stored with each booking, so later admin changes never reprice an active ride. */
function rateFor(input: { category?: unknown; fareRate?: unknown }): FareRate {
  const category = normalizeFareCategory(input.category);
  return input.fareRate ? normalizeFareRate(input.fareRate, category) : getDefaultFareRate(category);
}

/** The amount accepted by the Rider at booking time. */
export function getQuotedRideFare(ride: RideFareFields): number {
  return roundGhsFare(
    ride.quoted_fare
      ?? ride.fare_estimate
      ?? ride.base_fare
      ?? ride.fare
      ?? ride.final_fare
      ?? 0,
  );
}

/** Waiting fees are an explicit, separately recorded charge. */
export function getWaitingFee(ride: RideFareFields): number {
  return finiteNonNegative(ride.waiting_fee);
}

export function getFareRate(category: unknown): FareRate {
  return getDefaultFareRate(category);
}

/**
 * Waiting runs from the server-recorded Driver arrival to the server-recorded
 * Start Trip time. A Driver can see a preview but cannot set the final charge.
 */
export function getWaitingCharge(input: {
  category?: unknown;
  fareRate?: unknown;
  arrivedAt?: unknown;
  tripStartedAt?: unknown;
  freeMinutes?: unknown;
}): WaitingCharge {
  const arrivedAtMs = new Date(String(input.arrivedAt || '')).getTime();
  const tripStartedAtMs = new Date(String(input.tripStartedAt || '')).getTime();
  if (!Number.isFinite(arrivedAtMs) || !Number.isFinite(tripStartedAtMs) || tripStartedAtMs <= arrivedAtMs) {
    return { waitedMinutes: 0, chargeableMinutes: 0, ratePerMinute: 0, waitingFee: 0 };
  }
  const rate = rateFor({ category: input.category, fareRate: input.fareRate });
  const suppliedFreeMinutes = Number(input.freeMinutes);
  const freeMinutes = Number.isFinite(suppliedFreeMinutes) && suppliedFreeMinutes >= 0
    ? Math.min(suppliedFreeMinutes, 30)
    : FREE_WAITING_MINUTES;
  const waitedMinutes = (tripStartedAtMs - arrivedAtMs) / 60_000;
  const chargeableMinutes = Math.max(0, waitedMinutes - freeMinutes);
  return {
    waitedMinutes: Number(waitedMinutes.toFixed(2)),
    chargeableMinutes: Number(chargeableMinutes.toFixed(2)),
    ratePerMinute: rate.waitingFeePerMinute,
    waitingFee: Number((chargeableMinutes * rate.waitingFeePerMinute).toFixed(2)),
  };
}

/**
 * Derives a quote or final charge from the server-held category rate. The only
 * multiplier is the administrator-approved surge passed by the server booking
 * path; neither mobile client supplies a trusted rate or total.
 */
export function getMeteredFareBreakdown(input: {
  category?: unknown;
  distanceKm?: unknown;
  durationMinutes?: unknown;
  waitingFee?: unknown;
  surgeMultiplier?: unknown;
  fareRate?: unknown;
}): MeteredFareBreakdown {
  const category = normalizeFareCategory(input.category);
  const rate = rateFor({ category, fareRate: input.fareRate });
  const distanceKm = finiteNonNegative(input.distanceKm);
  const durationMinutes = finiteNonNegative(input.durationMinutes);
  const waitingFee = finiteNonNegative(input.waitingFee);
  const suppliedSurge = Number(input.surgeMultiplier);
  const surgeMultiplier = Number.isFinite(suppliedSurge) && suppliedSurge >= 1
    ? Math.min(suppliedSurge, 2)
    : 1;
  const distanceFare = distanceKm * rate.pricePerKm;
  const timeFare = durationMinutes * rate.pricePerMinute;
  const meteredSubtotal = (rate.baseFare + distanceFare + timeFare) * surgeMultiplier;
  const beforeWaiting = Math.max(meteredSubtotal, rate.minFare) + rate.bookingFee;

  return {
    category,
    baseFare: rate.baseFare,
    distanceKm: Number(distanceKm.toFixed(3)),
    distanceRate: rate.pricePerKm,
    distanceFare: Number(distanceFare.toFixed(2)),
    durationMinutes: Number(durationMinutes.toFixed(2)),
    timeRate: rate.pricePerMinute,
    timeFare: Number(timeFare.toFixed(2)),
    surgeMultiplier,
    minimumFare: rate.minFare,
    bookingFee: rate.bookingFee,
    waitingFee: Number(waitingFee.toFixed(2)),
    total: roundGhsFare(beforeWaiting + waitingFee),
  };
}

export function getMeteredTripFare(input: {
  category?: unknown;
  distanceKm?: unknown;
  durationMinutes?: unknown;
  waitingFee?: unknown;
  surgeMultiplier?: unknown;
  fareRate?: unknown;
}): number {
  return getMeteredFareBreakdown(input).total;
}

/** Server wall-clock duration, valid only after the recorded Start Trip timestamp. */
export function getTripDurationMinutes(startedAt: unknown, completedAt = Date.now()): number {
  const startMs = new Date(String(startedAt || '')).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(completedAt) || completedAt < startMs) return 0;
  return Math.max(0, (completedAt - startMs) / 60_000);
}

/** Only a ride that has not started may be cancelled without a trip charge. */
export function canCancelRideBeforeTrip(ride: RideFareFields): boolean {
  return ['searching', 'matched', 'driver_arriving', 'driver_arrived', 'driver_queued']
    .includes(String(ride.status || '').trim().toLowerCase());
}

/**
 * A Rider may withdraw a still-searching request without giving a reason.
 * Once a Driver is assigned, retain a concise cancellation reason for the
 * Driver-facing operational record. Status is included as a defensive fallback
 * for legacy records whose driver identifier was not persisted correctly.
 */
export function requiresRiderCancellationReason(ride: RideFareFields): boolean {
  const status = String(ride.status || '').trim().toLowerCase();
  const embeddedDriver = ride.driver;
  const embeddedDriverId = embeddedDriver && typeof embeddedDriver === 'object'
    ? (embeddedDriver as Record<string, unknown>).id
    : undefined;
  const driverId = String(ride.driver_id ?? ride.driverId ?? embeddedDriverId ?? '').trim();
  return Boolean(driverId) || ['matched', 'driver_arriving', 'driver_arrived', 'driver_queued'].includes(status);
}

/** Terminal cancellation records are deliberately non-chargeable. */
export function cancelledRideNoChargePatch(input: {
  cancelledBy: 'rider' | 'driver' | 'system';
  reason: string;
  cancelledAt: string;
}): Record<string, unknown> {
  return {
    status: 'cancelled',
    cancelled_by: input.cancelledBy,
    cancellation_reason: input.reason,
    cancelled_at: input.cancelledAt,
    cancellation_fee: 0,
    waiting_time_minutes: 0,
    waiting_chargeable_minutes: 0,
    waiting_fee_per_minute: 0,
    waiting_fee: 0,
    fare: 0,
    fare_estimate: 0,
    final_fare: 0,
    tip_amount: 0,
    driver_earnings: 0,
    fare_authority: 'cancelled_no_charge',
  };
}

/** Accept compatibility distance only in a narrow cap derived from the route estimate. */
export function getCappedCompatibilityDistanceKm(reportedDistance: unknown, estimatedDistance: unknown): number | null {
  const reported = Number(reportedDistance);
  if (!Number.isFinite(reported) || reported < 0) return null;
  const estimate = finiteNonNegative(estimatedDistance);
  const cap = estimate > 0 ? Math.max(0.75, estimate * 1.35 + 0.5) : 2;
  return Number(Math.min(reported, cap).toFixed(3));
}

/** Completed rides persist their server-calculated final fare. */
export function getAuthoritativeFinalFare(ride: RideFareFields): number {
  if (String(ride.status || '').trim().toLowerCase() === 'cancelled') return 0;
  const storedFinal = Number(ride.final_fare);
  if ((ride.status === 'completed' || ride.fare_authority === 'metered_trip') && Number.isFinite(storedFinal) && storedFinal >= 0) {
    return roundGhsFare(storedFinal);
  }
  return roundGhsFare(getQuotedRideFare(ride) + getWaitingFee(ride));
}

export function getTripChargeTotal(ride: RideFareFields): number {
  if (String(ride.status || '').trim().toLowerCase() === 'cancelled') return 0;
  const tip = Number(ride.tip_amount ?? 0);
  const safeTip = Number.isFinite(tip) && tip > 0 ? tip : 0;
  return roundGhsFare(getAuthoritativeFinalFare(ride) + safeTip);
}

/** A Driver can start only after the server has recorded arrival at pickup. */
export function canStartTrip(ride: RideFareFields): boolean {
  return ride.status === 'driver_arrived';
}

/** A trip can create a final fare only after it was explicitly started. */
export function canCompleteTrip(ride: RideFareFields): boolean {
  return ride.status === 'in_progress' && Boolean(ride.trip_started_at);
}
