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
/**
 * HY3N price display rule: show Ghana cedi fares as whole amounts. Amounts with
 * a fractional component of .50 or less round down; amounts above .50 round up.
 */
export declare function roundGhsFare(value: unknown): number;
/**
 * The price accepted by the Rider at booking time. It remains a booking
 * estimate; completion uses the metered distance and duration below.
 */
export declare function getQuotedRideFare(ride: RideFareFields): number;
/** Waiting fees are an explicit, separately recorded charge. */
export declare function getWaitingFee(ride: RideFareFields): number;
export declare function getFareRate(category: unknown): FareRate;
/**
 * Derive the final charge from post-Start Trip mileage and server elapsed time.
 * A route estimate is never used as a fallback fare. A stationary trip may
 * still reach the category minimum, but can never inherit the booked route's
 * full price.
 */
export declare function getMeteredFareBreakdown(input: {
    category?: unknown;
    distanceKm?: unknown;
    durationMinutes?: unknown;
    waitingFee?: unknown;
    surgeMultiplier?: unknown;
}): MeteredFareBreakdown;
export declare function getMeteredTripFare(input: {
    category?: unknown;
    distanceKm?: unknown;
    durationMinutes?: unknown;
    waitingFee?: unknown;
    surgeMultiplier?: unknown;
}): number;
/** Server wall-clock duration, valid only after Start Trip. */
export declare function getTripDurationMinutes(startedAt: unknown, completedAt?: number): number;
/**
 * Current build compatibility: before the Driver app sends each active-trip GPS
 * point to the server, accept its tracked distance only within a narrow cap
 * derived from the original route estimate. Zero remains zero and never falls
 * back to the estimate.
 */
export declare function getCappedCompatibilityDistanceKm(reportedDistance: unknown, estimatedDistance: unknown): number | null;
/**
 * Completed rides persist their server-calculated final fare. Older incomplete
 * rides retain quote-plus-waiting behavior until they are completed.
 */
export declare function getAuthoritativeFinalFare(ride: RideFareFields): number;
export declare function getTripChargeTotal(ride: RideFareFields): number;
/** A Driver can start only after the server has recorded arrival at pickup. */
export declare function canStartTrip(ride: RideFareFields): boolean;
/**
 * A trip can create a final fare only after it was explicitly started. This
 * prevents an arriving or waiting ride from being marked completed/charged.
 */
export declare function canCompleteTrip(ride: RideFareFields): boolean;
