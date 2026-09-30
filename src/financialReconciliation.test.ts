import { describe, expect, it } from 'vitest';
import { reconcileFinancialRecords } from './financialReconciliation';

const now = new Date('2026-10-01T02:15:00.000Z');

function completedRide(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ride-1',
    status: 'completed',
    final_fare: 42,
    tip_amount: 2,
    completed_at: '2026-09-30T17:00:00.000Z',
    ...overrides,
  };
}

describe('daily financial and wallet reconciliation', () => {
  it('passes when a non-wallet completed ride has no wallet settlement', () => {
    const audit = reconcileFinancialRecords({
      rides: [completedRide({ payment_method: 'cash' })],
      walletTransactions: [],
      now,
    });

    expect(audit.status).toBe('passed');
    expect(audit.exceptionCount).toBe(0);
    expect(audit.rideLedger).toMatchObject({
      completedRides: 1,
      confirmedCompletedRides: 1,
      confirmedChargeTotal: 44,
    });
    expect(audit.walletSettlement).toMatchObject({
      walletFundedCompletedRides: 0,
      expectedSettlementTotal: 0,
      missingSettlementRides: 0,
      unexpectedNonWalletSettlementRides: 0,
    });
  });

  it('matches exactly one rider debit and driver credit for a wallet-funded ride', () => {
    const audit = reconcileFinancialRecords({
      rides: [completedRide({ payment: 'wallet' })],
      walletTransactions: [
        { id: 'debit-1', ride_id: 'ride-1', reference: 'hy3n-ride-ride-1', type: 'debit', amount: 44 },
        { id: 'credit-1', ride_id: 'ride-1', reference: 'hy3n-ride-ride-1', type: 'credit', amount: 44 },
      ],
      now,
    });

    expect(audit.status).toBe('passed');
    expect(audit.walletSettlement).toMatchObject({
      walletFundedCompletedRides: 1,
      expectedSettlementTotal: 44,
      fullyMatchedRides: 1,
      riderDebitTotal: 44,
      driverCreditTotal: 44,
    });
  });

  it('flags a missing or mismatched wallet settlement without changing records', () => {
    const audit = reconcileFinancialRecords({
      rides: [completedRide({ payment_collection: 'wallet' })],
      walletTransactions: [{ id: 'debit-only', ride_id: 'ride-1', reference: 'hy3n-ride-ride-1', type: 'debit', amount: 40 }],
      now,
    });

    expect(audit.status).toBe('exception');
    expect(audit.walletSettlement).toMatchObject({
      missingSettlementRides: 0,
      duplicateSettlementRides: 1,
      amountMismatchRides: 1,
      riderDebitTotal: 40,
      driverCreditTotal: 0,
    });
    expect(audit.exceptions.map((exception) => exception.code)).toEqual(expect.arrayContaining([
      'duplicate_wallet_settlement',
      'wallet_settlement_amount_mismatch',
    ]));
  });

  it('keeps legacy quote-only rides outside confirmed charges and marks attention', () => {
    const audit = reconcileFinancialRecords({
      rides: [{ id: 'legacy-quote', status: 'completed', fare_estimate: 77 }],
      walletTransactions: [],
      now,
    });

    expect(audit.status).toBe('attention');
    expect(audit.exceptionCount).toBe(0);
    expect(audit.attentionCount).toBe(1);
    expect(audit.rideLedger).toMatchObject({
      confirmedCompletedRides: 0,
      confirmedChargeTotal: 0,
      legacyQuoteEstimateRides: 1,
      legacyQuoteEstimateTotal: 77,
    });
  });

  it('flags a wallet transaction that has remained processing for more than 48 hours', () => {
    const audit = reconcileFinancialRecords({
      rides: [],
      walletTransactions: [{
        id: 'stale-processing',
        type: 'credit',
        amount: 12,
        status: 'processing',
        date: '2026-09-28T02:14:59.000Z',
      }],
      now,
    });

    expect(audit.status).toBe('exception');
    expect(audit.walletTransactions).toMatchObject({
      processingCount: 1,
      staleProcessingCount: 1,
      staleProcessingAmount: 12,
    });
    expect(audit.exceptions).toContainEqual({ code: 'stale_processing_wallet_transaction', count: 1, amount: 12 });
  });
});
