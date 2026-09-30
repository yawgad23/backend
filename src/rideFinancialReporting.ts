import { getQuotedRideFare, getWaitingFee } from './fareAuthority';

export type RideFinancialRecord = {
  id: string;
  status: 'completed' | 'cancelled';
  riderName: string;
  driverName: string | null;
  category: string | null;
  paymentMethod: string | null;
  pickupAddress: string | null;
  destinationAddress: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  updatedAt: string | null;
  fareAmount: number;
  fareSource: 'recorded_final' | 'legacy_fare' | 'legacy_quote_estimate' | 'unavailable';
  legacyQuoteEstimate: number;
  waitingMinutes: number;
  chargeableWaitingMinutes: number;
  waitingFeeRate: number;
  waitingFee: number;
  tipAmount: number;
  totalRideCharge: number;
  cancellationPenalty: number;
  fareAuthority: string | null;
};

export type RideFinancialSummary = {
  records: number;
  completedRides: number;
  confirmedCompletedRides: number;
  legacyQuoteEstimateRides: number;
  cancelledRides: number;
  fareAmountTotal: number;
  waitingFeeTotal: number;
  tipAmountTotal: number;
  totalRideCharge: number;
  cancellationPenaltyTotal: number;
  legacyQuoteEstimateTotal: number;
};

function nonNegative(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/** Financial report components retain pesewas; fare rounding is not aggregation rounding. */
function reportMoney(value: number): number {
  return Number(value.toFixed(2));
}

function stringOrNull(value: unknown): string | null {
  const text = String(value || '').trim();
  return text || null;
}

/**
 * Current rides persist a server-rounded final amount. Some legacy completed
 * records retain pesewa amounts, so reports preserve the recorded amount for
 * reconciliation rather than applying the current display-rounding rule again.
 * A legacy quote is explicitly not treated as a completed financial charge.
 */
function recordedFare(ride: Record<string, any>): {
  amount: number;
  source: RideFinancialRecord['fareSource'];
} {
  const hasStoredFinal = ride.final_fare !== undefined && ride.final_fare !== null && ride.final_fare !== '';
  const storedFinal = Number(ride.final_fare);
  if (hasStoredFinal && Number.isFinite(storedFinal) && storedFinal >= 0) {
    return { amount: reportMoney(storedFinal), source: 'recorded_final' };
  }

  const hasLegacyFare = ride.fare !== undefined && ride.fare !== null && ride.fare !== '';
  const legacyFare = Number(ride.fare);
  if (hasLegacyFare && Number.isFinite(legacyFare) && legacyFare >= 0) {
    return { amount: reportMoney(legacyFare), source: 'legacy_fare' };
  }

  const quoteEstimate = getQuotedRideFare(ride);
  if (quoteEstimate > 0) return { amount: quoteEstimate, source: 'legacy_quote_estimate' };
  return { amount: 0, source: 'unavailable' };
}

function recordedTripChargeTotal(ride: Record<string, any>, fareAmount: number): number {
  const tip = nonNegative(ride.tip_amount);
  return reportMoney(fareAmount + tip);
}

/**
 * Converts only completed and cancelled server ride records into finance-safe
 * report rows. `totalRideCharge` already includes `waitingFee`; reports must
 * display the latter as a component and never add it to this total again.
 */
export function financialRideRecord(ride: Record<string, any>): RideFinancialRecord | null {
  const status = String(ride.status || '').trim().toLowerCase();
  if (status !== 'completed' && status !== 'cancelled') return null;

  const waitingFee = status === 'completed' ? getWaitingFee(ride) : 0;
  const waitingMinutes = status === 'completed' ? nonNegative(ride.waiting_time_minutes) : 0;
  const chargeableWaitingMinutes = status === 'completed' ? nonNegative(ride.waiting_chargeable_minutes) : 0;
  const waitingFeeRate = status === 'completed' ? nonNegative(ride.waiting_fee_per_minute) : 0;
  const recorded = status === 'completed' ? recordedFare(ride) : { amount: 0, source: 'unavailable' as const };
  const isConfirmedFare = recorded.source === 'recorded_final' || recorded.source === 'legacy_fare';
  const tipAmount = status === 'completed' && isConfirmedFare ? nonNegative(ride.tip_amount) : 0;
  const fareAmount = status === 'completed' && isConfirmedFare ? recorded.amount : 0;
  const legacyQuoteEstimate = status === 'completed' && recorded.source === 'legacy_quote_estimate' ? recorded.amount : 0;
  const totalRideCharge = status === 'completed' && isConfirmedFare ? recordedTripChargeTotal(ride, fareAmount) : 0;
  // Current cancellation policy writes zero. Preserve a valid historic value
  // for audit instead of silently changing historical books.
  const cancellationPenalty = status === 'cancelled' ? reportMoney(nonNegative(ride.cancellation_fee)) : 0;

  return {
    id: String(ride.id || ''),
    status,
    riderName: String(ride.rider_name || ride.rider?.name || 'Rider'),
    driverName: stringOrNull(ride.driver_name || ride.driver?.name),
    category: stringOrNull(ride.category || ride.vehicle_type),
    paymentMethod: stringOrNull(ride.payment_method || ride.payment),
    pickupAddress: stringOrNull(ride.pickup?.address || ride.pickup_address || ride.pickup_location),
    destinationAddress: stringOrNull(ride.destination?.address || ride.destination_address || ride.dropoff_location),
    completedAt: stringOrNull(ride.completed_at),
    cancelledAt: stringOrNull(ride.cancelled_at),
    updatedAt: stringOrNull(ride.updated_date || ride.updated_at),
    fareAmount,
    fareSource: recorded.source,
    legacyQuoteEstimate,
    waitingMinutes,
    chargeableWaitingMinutes,
    waitingFeeRate,
    waitingFee,
    tipAmount,
    totalRideCharge,
    cancellationPenalty,
    fareAuthority: stringOrNull(ride.fare_authority),
  };
}

export function summarizeRideFinancials(records: RideFinancialRecord[]): RideFinancialSummary {
  const summary = records.reduce((totals, record) => {
    totals.records += 1;
    if (record.status === 'completed') {
      totals.completedRides += 1;
      if (record.fareSource === 'legacy_quote_estimate') {
        totals.legacyQuoteEstimateRides += 1;
        totals.legacyQuoteEstimateTotal += record.legacyQuoteEstimate;
      } else if (record.fareSource !== 'unavailable') {
        totals.confirmedCompletedRides += 1;
        totals.fareAmountTotal += record.fareAmount;
        totals.waitingFeeTotal += record.waitingFee;
        totals.tipAmountTotal += record.tipAmount;
        totals.totalRideCharge += record.totalRideCharge;
      }
    } else {
      totals.cancelledRides += 1;
      totals.cancellationPenaltyTotal += record.cancellationPenalty;
    }
    return totals;
  }, {
    records: 0,
    completedRides: 0,
    confirmedCompletedRides: 0,
    legacyQuoteEstimateRides: 0,
    cancelledRides: 0,
    fareAmountTotal: 0,
    waitingFeeTotal: 0,
    tipAmountTotal: 0,
    totalRideCharge: 0,
    cancellationPenaltyTotal: 0,
    legacyQuoteEstimateTotal: 0,
  });

  return {
    ...summary,
    fareAmountTotal: reportMoney(summary.fareAmountTotal),
    waitingFeeTotal: reportMoney(summary.waitingFeeTotal),
    tipAmountTotal: reportMoney(summary.tipAmountTotal),
    totalRideCharge: reportMoney(summary.totalRideCharge),
    cancellationPenaltyTotal: reportMoney(summary.cancellationPenaltyTotal),
    legacyQuoteEstimateTotal: reportMoney(summary.legacyQuoteEstimateTotal),
  };
}
