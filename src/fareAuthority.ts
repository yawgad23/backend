export type RideFareFields = Record<string, unknown>;

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
 * The price accepted by the Rider at booking time. New rides store this as
 * `quoted_fare`; the other keys keep older ride records compatible.
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

/** Waiting fees are an explicit, separately recorded charge—not a Driver fare calculation. */
export function getWaitingFee(ride: RideFareFields): number {
  const value = Number(ride.waiting_fee ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Only the booking quote plus the already-recorded waiting fee can determine
 * a completed trip's fare. A Driver app's local GPS/time calculation is never
 * trusted as the amount charged to the Rider.
 */
export function getAuthoritativeFinalFare(ride: RideFareFields): number {
  return roundGhsFare(getQuotedRideFare(ride) + getWaitingFee(ride));
}

export function getTripChargeTotal(ride: RideFareFields): number {
  const tip = Number(ride.tip_amount ?? 0);
  const safeTip = Number.isFinite(tip) && tip > 0 ? tip : 0;
  return roundGhsFare(getAuthoritativeFinalFare(ride) + safeTip);
}
