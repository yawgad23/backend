import { describe, expect, it } from 'vitest';
import { commissionLedgerStatus, filterCommissionLedger, summarizeCommissionLedger } from './commissionLedger';

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
