export type CommissionLedgerRecord = Record<string, any>;

export type CommissionLedgerStatus = 'paid' | 'processing' | 'failed' | 'other';

const PAID_STATUSES = new Set(['paid', 'confirmed', 'completed']);
const PROCESSING_STATUSES = new Set(['processing', 'pending', 'initiated']);
const FAILED_STATUSES = new Set(['failed', 'expired', 'cancelled', 'declined']);

export function commissionLedgerStatus(value: unknown): CommissionLedgerStatus {
  const status = String(value ?? '').trim().toLowerCase();
  if (PAID_STATUSES.has(status)) return 'paid';
  if (PROCESSING_STATUSES.has(status)) return 'processing';
  if (FAILED_STATUSES.has(status)) return 'failed';
  return 'other';
}

export function commissionLedgerDate(record: CommissionLedgerRecord): string {
  const raw = record.date || record.submitted_at || record.created_date || record.updated_date;
  const value = typeof raw === 'string' ? raw : '';
  return value.slice(0, 10);
}

export function filterCommissionLedger(
  records: CommissionLedgerRecord[],
  filters: { dateFrom?: string; dateTo?: string; status?: string },
): CommissionLedgerRecord[] {
  return records.filter((record) => {
    const date = commissionLedgerDate(record);
    if (filters.dateFrom && (!date || date < filters.dateFrom)) return false;
    if (filters.dateTo && (!date || date > filters.dateTo)) return false;
    if (filters.status && commissionLedgerStatus(record.status) !== filters.status) return false;
    return true;
  });
}

function money(value: unknown): number {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : 0;
}

export function summarizeCommissionLedger(records: CommissionLedgerRecord[], today: string) {
  const totals = {
    records: records.length,
    paidCount: 0,
    processingCount: 0,
    failedCount: 0,
    paidAmount: 0,
    processingAmount: 0,
    failedAmount: 0,
    todayPaidAmount: 0,
  };

  for (const record of records) {
    const amount = money(record.amount);
    const status = commissionLedgerStatus(record.status);
    if (status === 'paid') {
      totals.paidCount += 1;
      totals.paidAmount += amount;
      if (commissionLedgerDate(record) === today) totals.todayPaidAmount += amount;
    } else if (status === 'processing') {
      totals.processingCount += 1;
      totals.processingAmount += amount;
    } else if (status === 'failed') {
      totals.failedCount += 1;
      totals.failedAmount += amount;
    }
  }

  return Object.fromEntries(
    Object.entries(totals).map(([key, value]) => [
      key,
      typeof value === 'number' && key.endsWith('Amount') ? Math.round(value * 100) / 100 : value,
    ]),
  ) as typeof totals;
}
