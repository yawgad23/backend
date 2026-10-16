export type CommissionLedgerRecord = Record<string, any>;

export type CommissionLedgerStatus = 'paid' | 'processing' | 'failed' | 'other';

const PAID_STATUSES = new Set(['paid', 'confirmed', 'completed']);
const PROCESSING_STATUSES = new Set(['processing', 'pending', 'initiated']);
const FAILED_STATUSES = new Set(['failed', 'expired', 'cancelled', 'declined']);

/** A Driver fee opens access for exactly 24 elapsed hours, never a calendar day. */
export const DRIVER_PLATFORM_FEE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Pending MoMo requests use the same 48-hour expiry as the reconciler. */
export const DRIVER_PLATFORM_FEE_PROCESSING_WINDOW_MS = 48 * 60 * 60 * 1000;

export type DriverPlatformFeeAccess = {
  isPaid: boolean;
  status: 'paid' | 'expired' | 'unpaid';
  confirmedPaidAt: string | null;
  accessExpiresAt: string | null;
  remainingMs: number;
  /** Historical records may use a bounded server-side compatibility timestamp. */
  confirmedAtSource: 'confirmed_payment' | 'legacy_server_record' | null;
  validityLabel: string;
  record: CommissionLedgerRecord | null;
};

export type DriverPlatformFeePaymentDecision =
  | { state: 'active'; access: DriverPlatformFeeAccess }
  | { state: 'processing'; record: CommissionLedgerRecord }
  | { state: 'charge_required' };

export type DriverPlatformFeeConfirmation = {
  alreadyConfirmed: boolean;
  confirmedPaidAt: string | null;
  accessExpiresAt: string | null;
  patch: Record<string, unknown>;
};

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

/** A calendar date does not prove an exact payment confirmation time. */
function exactServerTimestamp(value: unknown): string | null {
  if (value && typeof value === 'object' && typeof (value as { toDate?: unknown }).toDate === 'function') {
    try {
      return exactServerTimestamp((value as { toDate: () => Date }).toDate());
    } catch {
      return null;
    }
  }
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || /^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function serverTime(value: Date | number | string): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') return Date.parse(value);
  return value;
}

function legacyProviderPaid(record: CommissionLedgerRecord): boolean {
  return record.admin_override !== true
    && commissionLedgerStatus(record.status) === 'paid'
    && Boolean(String(record.hubtel_transaction_id || '').trim());
}

/**
 * New records must contain an immutable confirmation timestamp. For a legacy
 * provider-confirmed row without one, accept only a server webhook receipt or
 * server update time as a bounded compatibility anchor. Initiation, date, and
 * generic creation fields can never start confirmed-payment access.
 */
export function resolveDriverPlatformFeeConfirmation(record: CommissionLedgerRecord): {
  confirmedPaidAt: string | null;
  source: DriverPlatformFeeAccess['confirmedAtSource'];
} {
  const canonical = exactServerTimestamp(record.confirmed_paid_at)
    || exactServerTimestamp(record.paid_at);
  if (canonical) return { confirmedPaidAt: canonical, source: 'confirmed_payment' };
  if (!legacyProviderPaid(record)) return { confirmedPaidAt: null, source: null };

  const legacy = exactServerTimestamp(record.hubtel_webhook_received_at)
    || exactServerTimestamp(record.updated_date);
  return legacy
    ? { confirmedPaidAt: legacy, source: 'legacy_server_record' }
    : { confirmedPaidAt: null, source: null };
}

export function driverPlatformFeeExpiry(confirmedPaidAt: string): string | null {
  const time = Date.parse(confirmedPaidAt);
  return Number.isFinite(time)
    ? new Date(time + DRIVER_PLATFORM_FEE_WINDOW_MS).toISOString()
    : null;
}

/**
 * One server-authoritative rolling-window decision. A fee is valid strictly
 * before its expiry millisecond and expires exactly at the same time next day.
 */
export function currentDriverPlatformFeeAccess(
  records: CommissionLedgerRecord[],
  now: Date | number | string = Date.now(),
): DriverPlatformFeeAccess {
  const nowMs = serverTime(now);
  const windows = records
    .filter((record) => commissionLedgerStatus(record.status) === 'paid')
    .map((record) => {
      const confirmation = resolveDriverPlatformFeeConfirmation(record);
      const accessExpiresAt = confirmation.confirmedPaidAt
        ? driverPlatformFeeExpiry(confirmation.confirmedPaidAt)
        : null;
      const expiryMs = accessExpiresAt ? Date.parse(accessExpiresAt) : Number.NaN;
      const isPaid = Number.isFinite(expiryMs) && nowMs < expiryMs;
      return {
        isPaid,
        status: isPaid ? 'paid' as const : 'expired' as const,
        confirmedPaidAt: confirmation.confirmedPaidAt,
        accessExpiresAt,
        remainingMs: isPaid ? Math.max(0, expiryMs - nowMs) : 0,
        confirmedAtSource: confirmation.source,
        validityLabel: 'Payment access is valid for 24 hours from Hubtel confirmation.',
        record,
      };
    })
    .filter((window) => Boolean(window.confirmedPaidAt && window.accessExpiresAt))
    .sort((a, b) => Date.parse(a.confirmedPaidAt || '') - Date.parse(b.confirmedPaidAt || ''));

  const active = windows.filter((window) => window.isPaid).pop();
  if (active) return active;
  const latestPaid = windows.pop();
  if (latestPaid) return latestPaid;

  return {
    isPaid: false,
    status: 'unpaid',
    confirmedPaidAt: null,
    accessExpiresAt: null,
    remainingMs: 0,
    confirmedAtSource: null,
    validityLabel: 'Payment access is valid for 24 hours from Hubtel confirmation.',
    record: null,
  };
}

function processingStartedAt(record: CommissionLedgerRecord): number | null {
  // Submission time is valid only for stale-request expiry, never paid access.
  const timestamp = exactServerTimestamp(record.submitted_at)
    || exactServerTimestamp(record.created_date);
  const time = timestamp ? Date.parse(timestamp) : Number.NaN;
  return Number.isFinite(time) ? time : null;
}

/** Returns one still-live USSD request without trusting mobile input. */
export function liveDriverPlatformFeePayment(
  records: CommissionLedgerRecord[],
  now: Date | number | string = Date.now(),
): CommissionLedgerRecord | null {
  const nowMs = serverTime(now);
  return records.find((record) => {
    if (commissionLedgerStatus(record.status) !== 'processing') return false;
    const startedAt = processingStartedAt(record);
    return startedAt !== null && nowMs >= startedAt && nowMs - startedAt < DRIVER_PLATFORM_FEE_PROCESSING_WINDOW_MS;
  }) || null;
}

/** Prevents a duplicate charge while access or a live USSD request already exists. */
export function driverPlatformFeePaymentDecision(
  records: CommissionLedgerRecord[],
  now: Date | number | string = Date.now(),
): DriverPlatformFeePaymentDecision {
  const access = currentDriverPlatformFeeAccess(records, now);
  if (access.isPaid) return { state: 'active', access };
  const processing = liveDriverPlatformFeePayment(records, now);
  return processing ? { state: 'processing', record: processing } : { state: 'charge_required' };
}

/**
 * Builds immutable confirmation fields exactly once. The caller persists this
 * inside a Firestore transaction, so callback/poll duplicates cannot move the
 * anchor or expiry. A historical paid row without an anchor is never reset to
 * the current time by a duplicate provider notification.
 */
export function buildDriverPlatformFeeConfirmation(
  record: CommissionLedgerRecord,
  confirmedAt: Date | number | string = Date.now(),
): DriverPlatformFeeConfirmation {
  const existing = resolveDriverPlatformFeeConfirmation(record);
  if (existing.confirmedPaidAt) {
    return {
      alreadyConfirmed: true,
      confirmedPaidAt: existing.confirmedPaidAt,
      accessExpiresAt: driverPlatformFeeExpiry(existing.confirmedPaidAt),
      patch: {},
    };
  }
  if (commissionLedgerStatus(record.status) === 'paid') {
    return { alreadyConfirmed: true, confirmedPaidAt: null, accessExpiresAt: null, patch: {} };
  }
  const time = serverTime(confirmedAt);
  if (!Number.isFinite(time)) throw new Error('A valid server confirmation time is required.');
  const confirmedPaidAt = new Date(time).toISOString();
  const accessExpiresAt = driverPlatformFeeExpiry(confirmedPaidAt);
  if (!accessExpiresAt) throw new Error('Unable to calculate the Driver fee expiry.');
  return {
    alreadyConfirmed: false,
    confirmedPaidAt,
    accessExpiresAt,
    patch: {
      status: 'paid',
      confirmed_paid_at: confirmedPaidAt,
      paid_at: confirmedPaidAt,
      access_expires_at: accessExpiresAt,
    },
  };
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
