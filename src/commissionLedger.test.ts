import { describe, expect, it } from 'vitest';
import {
  buildDriverPlatformFeeConfirmation,
  commissionLedgerStatus,
  currentDriverPlatformFeeAccess,
  driverPlatformFeePaymentDecision,
  filterCommissionLedger,
  summarizeCommissionLedger,
} from './commissionLedger';

describe('commission ledger helpers', () => {
  const records = [
    { id: 'paid', status: 'Paid', amount: 0.1, date: '2026-09-25' },
    { id: 'pending', status: 'processing', amount: 50, date: '2026-09-24' },
    { id: 'failed', status: 'Declined', amount: 30, date: '2026-09-23' },
  ];

  it('normalizes only provider states into dashboard states', () => {
    expect(commissionLedgerStatus('confirmed')).toBe('paid');
    expect(commissionLedgerStatus('Pending')).toBe('processing');
    expect(commissionLedgerStatus('Expired')).toBe('failed');
    expect(commissionLedgerStatus('unknown')).toBe('other');
  });

  it('filters the ledger without mutating settlement records', () => {
    expect(filterCommissionLedger(records, { dateFrom: '2026-09-24' }).map((record) => record.id)).toEqual(['paid', 'pending']);
    expect(filterCommissionLedger(records, { status: 'paid' }).map((record) => record.id)).toEqual(['paid']);
  });

  it('keeps paid, pending, and failed Hubtel totals distinct', () => {
    expect(summarizeCommissionLedger(records, '2026-09-25')).toMatchObject({
      records: 3,
      paidCount: 1,
      paidAmount: 0.1,
      todayPaidAmount: 0.1,
      processingCount: 1,
      processingAmount: 50,
      failedCount: 1,
      failedAmount: 30,
    });
  });
});

describe('Driver platform fee rolling access window', () => {
  const confirmedAt = '2026-10-16T14:30:00.000Z';
  const paidRecord = {
    id: 'confirmed-fee',
    status: 'paid',
    submitted_at: '2026-10-16T13:45:00.000Z',
    confirmed_paid_at: confirmedAt,
    paid_at: confirmedAt,
    access_expires_at: '2026-10-17T14:30:00.000Z',
    hubtel_transaction_id: 'provider-transaction',
  };

  it('starts at Hubtel confirmation, not the earlier USSD initiation', () => {
    const access = currentDriverPlatformFeeAccess([paidRecord], '2026-10-17T14:29:59.999Z');

    expect(access).toMatchObject({
      isPaid: true,
      confirmedPaidAt: '2026-10-16T14:30:00.000Z',
      accessExpiresAt: '2026-10-17T14:30:00.000Z',
    });
    expect(access.remainingMs).toBe(1);
  });

  it('expires exactly at the same time next day, even across midnight', () => {
    expect(currentDriverPlatformFeeAccess([paidRecord], '2026-10-16T23:59:59.999Z').isPaid).toBe(true);
    expect(currentDriverPlatformFeeAccess([paidRecord], '2026-10-17T00:00:00.000Z').isPaid).toBe(true);
    expect(currentDriverPlatformFeeAccess([paidRecord], '2026-10-17T14:30:00.000Z')).toMatchObject({
      isPaid: false,
      status: 'expired',
      remainingMs: 0,
    });
  });

  it('does not grant access for a USSD request that has not been paid', () => {
    const pending = {
      id: 'pending-fee',
      status: 'processing',
      submitted_at: '2026-10-16T14:30:00.000Z',
    };
    expect(currentDriverPlatformFeeAccess([pending], '2026-10-16T15:00:00.000Z').isPaid).toBe(false);
    expect(driverPlatformFeePaymentDecision([pending], '2026-10-16T15:00:00.000Z').state).toBe('processing');
  });

  it('selects the newest still-valid confirmed payment', () => {
    const newer = {
      ...paidRecord,
      id: 'newer-fee',
      confirmed_paid_at: '2026-10-17T13:00:00.000Z',
      paid_at: '2026-10-17T13:00:00.000Z',
      access_expires_at: '2026-10-18T13:00:00.000Z',
    };
    expect(currentDriverPlatformFeeAccess([paidRecord, newer], '2026-10-17T14:00:00.000Z')).toMatchObject({
      isPaid: true,
      confirmedPaidAt: '2026-10-17T13:00:00.000Z',
      accessExpiresAt: '2026-10-18T13:00:00.000Z',
    });
  });

  it('never uses a legacy submitted_at or date value as payment confirmation', () => {
    const legacyWithoutEvidence = {
      id: 'legacy-no-proof',
      status: 'paid',
      submitted_at: '2026-10-16T14:30:00.000Z',
      date: '2026-10-16',
    };
    expect(currentDriverPlatformFeeAccess([legacyWithoutEvidence], '2026-10-16T15:00:00.000Z')).toMatchObject({
      isPaid: false,
      status: 'unpaid',
    });
  });

  it('uses only a bounded server timestamp for a legacy provider-confirmed row', () => {
    const legacyWithServerRecord = {
      id: 'legacy-server-evidence',
      status: 'completed',
      submitted_at: '2026-10-16T09:00:00.000Z',
      updated_date: '2026-10-16T14:30:00.000Z',
      hubtel_transaction_id: 'provider-transaction',
    };
    expect(currentDriverPlatformFeeAccess([legacyWithServerRecord], '2026-10-17T14:29:59.999Z')).toMatchObject({
      isPaid: true,
      confirmedPaidAt: '2026-10-16T14:30:00.000Z',
      confirmedAtSource: 'legacy_server_record',
    });
  });

  it('does not let duplicate provider confirmations extend an existing window', () => {
    const first = buildDriverPlatformFeeConfirmation({ id: 'fee', status: 'processing' }, '2026-10-16T14:30:00.000Z');
    const duplicate = buildDriverPlatformFeeConfirmation({
      id: 'fee',
      status: 'paid',
      ...first.patch,
    }, '2026-10-16T16:00:00.000Z');

    expect(first).toMatchObject({
      alreadyConfirmed: false,
      confirmedPaidAt: '2026-10-16T14:30:00.000Z',
      accessExpiresAt: '2026-10-17T14:30:00.000Z',
    });
    expect(duplicate).toMatchObject({
      alreadyConfirmed: true,
      confirmedPaidAt: '2026-10-16T14:30:00.000Z',
      accessExpiresAt: '2026-10-17T14:30:00.000Z',
      patch: {},
    });
  });

  it('keeps manual status overrides separate from Hubtel payment access', () => {
    expect(currentDriverPlatformFeeAccess([{
      id: 'manual',
      status: 'paid',
      admin_override: true,
      admin_override_at: '2026-10-16T14:30:00.000Z',
    }], '2026-10-16T15:00:00.000Z').isPaid).toBe(false);
  });
});
