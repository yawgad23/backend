export type DriverFinanceRide = Record<string, unknown>;

export const DRIVER_CASH_PAYOUTS_DISABLED_MESSAGE =
  'HY3N does not hold Driver cash fares for payout. Riders pay Drivers directly, so there is no cash balance to withdraw.';

function normalise(value: unknown) {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/**
 * A direct collection is money paid straight to the Driver, not money held by
 * HY3N. It is deliberately display-only and never becomes payout eligible.
 */
export function isDirectDriverCollection(ride: DriverFinanceRide) {
  const collection = normalise(ride.payment_collection);
  if (['direct_to_driver', 'driver_collects_cash', 'cash_to_driver'].includes(collection)) return true;

  const method = normalise(ride.payment_method ?? ride.payment);
  return ['cash', 'cash_on_arrival', 'mobile_money', 'momo', 'direct_momo'].includes(method);
}

export function directDriverCollectionTotal(
  rides: DriverFinanceRide[],
  fareForRide: (ride: DriverFinanceRide) => number,
  tipForRide: (ride: DriverFinanceRide) => number,
) {
  return rides.reduce((sum, ride) => (
    isDirectDriverCollection(ride) ? sum + fareForRide(ride) + tipForRide(ride) : sum
  ), 0);
}

/** Cash collected by a Driver is never a HY3N wallet/payout balance. */
export function disabledDriverPayoutSummary() {
  return {
    enabled: false,
    availableBalance: 0,
    reason: DRIVER_CASH_PAYOUTS_DISABLED_MESSAGE,
  } as const;
}

/**
 * Payout requests must not be recorded while HY3N does not hold Driver trip
 * proceeds. This protects cash-paying Riders from an accidental second payout.
 */
export function rejectDriverPayoutRequest(): never {
  throw new Error(DRIVER_CASH_PAYOUTS_DISABLED_MESSAGE);
}
