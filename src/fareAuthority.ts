export type RideFareFields = Record<string, unknown>;

export type FareRate = {
  baseFare: number;
  pricePerKm: number;
  pricePerMinute: number;
  minFare: number;
};

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

const BOOKING_FEE = 2.5;
const DEFAULT_CATEGORY = 'standard';

// The backend owns the final calculation. These rates mirror the Rider and
// Driver category definitions so a mobile client cannot decide what to charge.
const FARE_RATES: Record<string, FareRate> = {
  standard: { baseFare: 10, pricePerKm: 3.65, pricePerMinute: 0.43, minFare: 16.5 },
  comfort: { baseFare: 16.2, pricePerKm: 4.95, pricePerMinute: 0.65, minFare: 27.5 },
  kantanka: { baseFare: 16.2, pricePerKm: 4.95, pricePerMinute: 0.65, minFare: 27.5 },
  executive: { baseFare: 27.5, pricePerKm: 6.6, pricePerMinute: 1.1, minFare: 44 },
  okada: { baseFare: 5.5, pricePerKm: 1.65, pricePerMinute: 0.33, minFare: 8.8 },
  express_delivery: { baseFare: 16.5, pricePerKm: 2.2, pricePerMinute: 0.55, minFare: 22 },
};

function finiteNonNegative(value: unknown, fallback = 0): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : fallback;
}

function resolvedCategory(value: unknown): string {
  const category = String(value || DEFAULT_CATEGORY).trim().toLowerCase();
  return FARE_RATES[category] ? category : DEFAULT_CATEGORY;
}

/**
 * HY3N price display rule: show Ghana cedi fares as whole amounts. Amounts with
 * a fractional component of .50 or less round down; amounts above .50 round up.
 */
export function roundGhsFare(value: unknown): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return 0;

  const whole = Math.floor(amount);
  return whole + (amount - whole > 0.5 ? 1 : 0);
}

/**
 * The price accepted by the Rider at booking time. It remains a booking
 * estimate; completion uses the metered distance and duration below.
 */
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
  return FARE_RATES[resolvedCategory(category)];
}

/**
 * Derive the final charge from post-Start Trip mileage and server elapsed time.
 * A route estimate is never used as a fallback fare. A stationary trip may
 * still reach the category minimum, but can never inherit the booked route's
 * full price.
 */
export function getMeteredFareBreakdown(input: {
  category?: unknown;
  distanceKm?: unknown;
  durationMinutes?: unknown;
  waitingFee?: unknown;
  surgeMultiplier?: unknown;
}): MeteredFareBreakdown {
  const category = resolvedCategory(input.category);
  const rate = FARE_RATES[category];
  const distanceKm = finiteNonNegative(input.distanceKm);
  const durationMinutes = finiteNonNegative(input.durationMinutes);
  const waitingFee = finiteNonNegative(input.waitingFee);
  // Surge is set on the ride by the server-side booking path. Keep a safe
  // bounded value even for legacy ride documents.
  const suppliedSurge = Number(input.surgeMultiplier);
  const surgeMultiplier = Number.isFinite(suppliedSurge) && suppliedSurge >= 1
    ? Math.min(suppliedSurge, 3)
    : 1;
  const distanceFare = distanceKm * rate.pricePerKm;
  const timeFare = durationMinutes * rate.pricePerMinute;
  const meteredSubtotal = (rate.baseFare + distanceFare + timeFare) * surgeMultiplier;
  const beforeWaiting = Math.max(meteredSubtotal, rate.minFare) + BOOKING_FEE;

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
    bookingFee: BOOKING_FEE,
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
}): number {
  return getMeteredFareBreakdown(input).total;
}

/** Server wall-clock duration, valid only after Start Trip. */
export function getTripDurationMinutes(startedAt: unknown, completedAt = Date.now()): number {
  const startMs = new Date(String(startedAt || '')).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(completedAt) || completedAt < startMs) return 0;
  return Math.max(0, (completedAt - startMs) / 60_000);
}

/**
 * Current build compatibility: before the Driver app sends each active-trip GPS
 * point to the server, accept its tracked distance only within a narrow cap
 * derived from the original route estimate. Zero remains zero and never falls
 * back to the estimate.
 */
export function getCappedCompatibilityDistanceKm(reportedDistance: unknown, estimatedDistance: unknown): number | null {
  const reported = Number(reportedDistance);
  if (!Number.isFinite(reported) || reported < 0) return null;
  const estimate = finiteNonNegative(estimatedDistance);
  const cap = estimate > 0 ? Math.max(0.75, estimate * 1.35 + 0.5) : 2;
  return Number(Math.min(reported, cap).toFixed(3));
}

/**
 * Completed rides persist their server-calculated final fare. Older incomplete
 * rides retain quote-plus-waiting behavior until they are completed.
 */
export function getAuthoritativeFinalFare(ride: RideFareFields): number {
  const storedFinal = Number(ride.final_fare);
  if ((ride.status === 'completed' || ride.fare_authority === 'metered_trip') && Number.isFinite(storedFinal) && storedFinal >= 0) {
    return roundGhsFare(storedFinal);
  }
  return roundGhsFare(getQuotedRideFare(ride) + getWaitingFee(ride));
}

export function getTripChargeTotal(ride: RideFareFields): number {
  const tip = Number(ride.tip_amount ?? 0);
  const safeTip = Number.isFinite(tip) && tip > 0 ? tip : 0;
  return roundGhsFare(getAuthoritativeFinalFare(ride) + safeTip);
}

/** A Driver can start only after the server has recorded arrival at pickup. */
export function canStartTrip(ride: RideFareFields): boolean {
  return ride.status === 'driver_arrived';
}

/**
 * A trip can create a final fare only after it was explicitly started. This
 * prevents an arriving or waiting ride from being marked completed/charged.
 */
export function canCompleteTrip(ride: RideFareFields): boolean {
  return ride.status === 'in_progress' && Boolean(ride.trip_started_at);
}
