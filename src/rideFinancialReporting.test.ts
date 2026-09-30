import { describe, expect, it } from 'vitest';
import { financialRideRecord, summarizeRideFinancials } from './rideFinancialReporting';

describe('ride financial reporting', () => {
  it('shows waiting fees as a component without double-counting them in the total charge', () => {
    const record = financialRideRecord({
      id: 'completed-1',
      status: 'completed',
      rider_name: 'Rider',
      driver_name: 'Driver',
      final_fare: 42,
      waiting_fee: 3.3,
      waiting_time_minutes: 8.5,
      waiting_chargeable_minutes: 5.5,
      waiting_fee_per_minute: 0.6,
      tip_amount: 2,
      completed_at: '2026-09-30T10:00:00.000Z',
      fare_authority: 'metered_trip',
    });
    expect(record).toMatchObject({
      status: 'completed',
      fareAmount: 42,
      waitingFee: 3.3,
      totalRideCharge: 44,
      cancellationPenalty: 0,
    });
    expect(summarizeRideFinancials([record!])).toMatchObject({
      completedRides: 1,
      fareAmountTotal: 42,
      waitingFeeTotal: 3.3,
      totalRideCharge: 44,
    });
  });

  it('keeps cancelled rides out of ride charges and retains only a historic penalty for audit', () => {
    const currentPolicy = financialRideRecord({
      id: 'cancelled-current',
      status: 'cancelled',
      fare: 80,
      final_fare: 80,
      waiting_fee: 5,
      cancellation_fee: 0,
      cancelled_at: '2026-09-30T10:00:00.000Z',
    });
    const historicPenalty = financialRideRecord({
      id: 'cancelled-legacy',
      status: 'cancelled',
      cancellation_fee: 4,
      cancelled_at: '2026-09-30T11:00:00.000Z',
    });
    expect(currentPolicy).toMatchObject({ fareAmount: 0, waitingFee: 0, totalRideCharge: 0, cancellationPenalty: 0 });
    expect(historicPenalty).toMatchObject({ fareAmount: 0, waitingFee: 0, totalRideCharge: 0, cancellationPenalty: 4 });
    expect(summarizeRideFinancials([currentPolicy!, historicPenalty!])).toMatchObject({
      completedRides: 0,
      cancelledRides: 2,
      totalRideCharge: 0,
      cancellationPenaltyTotal: 4,
    });
  });

  it('preserves a legacy recorded final fare instead of applying current fare rounding again', () => {
    const record = financialRideRecord({
      id: 'legacy-pesewa-fare',
      status: 'completed',
      final_fare: 42.5,
      tip_amount: 1.25,
    });
    expect(record).toMatchObject({
      fareAmount: 42.5,
      tipAmount: 1.25,
      totalRideCharge: 43.75,
    });
  });

  it('keeps a legacy quote estimate separate from completed ride charges', () => {
    const record = financialRideRecord({
      id: 'legacy-quote-only',
      status: 'completed',
      fare_estimate: 88,
      tip_amount: 4,
    });
    expect(record).toMatchObject({
      fareSource: 'legacy_quote_estimate',
      fareAmount: 0,
      legacyQuoteEstimate: 88,
      tipAmount: 0,
      totalRideCharge: 0,
    });
    expect(summarizeRideFinancials([record!])).toMatchObject({
      completedRides: 1,
      confirmedCompletedRides: 0,
      legacyQuoteEstimateRides: 1,
      totalRideCharge: 0,
      legacyQuoteEstimateTotal: 88,
    });
  });

  it('omits non-terminal rides from financial reports', () => {
    expect(financialRideRecord({ id: 'active', status: 'in_progress', fare: 999 })).toBeNull();
  });
});
