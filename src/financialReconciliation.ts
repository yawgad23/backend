import { adminFirestore, ADMIN_COLLECTIONS } from './firebaseAdmin';
import { financialRideRecord, summarizeRideFinancials, type RideFinancialRecord } from './rideFinancialReporting';

const GHANA_TIME_ZONE = 'Africa/Accra';
const STALE_PROCESSING_MS = 48 * 60 * 60 * 1_000;

type WalletTransaction = Record<string, any>;
type ReconciliationStatus = 'passed' | 'attention' | 'exception';

export type FinancialReconciliationAudit = {
  runDate: string;
  executedAt: string;
  status: ReconciliationStatus;
  exceptionCount: number;
  attentionCount: number;
  sourceTruncated: boolean;
  rideLedger: {
    terminalRecords: number;
    completedRides: number;
    confirmedCompletedRides: number;
    confirmedChargeTotal: number;
    waitingFeeTotal: number;
    tipAmountTotal: number;
    cancelledRides: number;
    cancellationPenaltyTotal: number;
    legacyQuoteEstimateRides: number;
    legacyQuoteEstimateTotal: number;
  };
  walletSettlement: {
    walletFundedCompletedRides: number;
    expectedSettlementTotal: number;
    fullyMatchedRides: number;
    riderDebitTotal: number;
    driverCreditTotal: number;
    missingSettlementRides: number;
    duplicateSettlementRides: number;
    amountMismatchRides: number;
    unexpectedNonWalletSettlementRides: number;
    orphanSettlementRecords: number;
  };
  walletTransactions: {
    completedCount: number;
    completedAmount: number;
    processingCount: number;
    processingAmount: number;
    failedCount: number;
    failedAmount: number;
    staleProcessingCount: number;
    staleProcessingAmount: number;
  };
  exceptions: Array<{ code: string; count: number; amount?: number }>;
};

function money(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(2)) : 0;
}

function nonNegative(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function isWalletFunded(ride: Record<string, any>): boolean {
  return /wallet/i.test(`${ride.payment_method || ''} ${ride.payment || ''} ${ride.payment_collection || ''}`);
}

function transactionDate(transaction: WalletTransaction): number | null {
  const value = transaction.date || transaction.created_date || transaction.created_at;
  const timestamp = new Date(String(value || '')).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function walletTransactionStatus(transaction: WalletTransaction): 'completed' | 'processing' | 'failed' | 'other' {
  const status = String(transaction.status || '').trim().toLowerCase();
  if (['completed', 'paid', 'success', 'confirmed'].includes(status)) return 'completed';
  if (['processing', 'pending', 'ussd_sent'].includes(status)) return 'processing';
  if (['failed', 'declined', 'cancelled', 'expired', 'rejected'].includes(status)) return 'failed';
  return 'other';
}

function rideSettlementRecords(rideId: string, transactions: WalletTransaction[]): WalletTransaction[] {
  const reference = `hy3n-ride-${rideId}`;
  return transactions.filter((transaction) => String(transaction.ride_id || '') === rideId || String(transaction.reference || '') === reference);
}

function dateInGhana(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: GHANA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function reconcileFinancialRecords(input: {
  rides: Record<string, any>[];
  walletTransactions: WalletTransaction[];
  now?: Date;
  runDate?: string;
}): FinancialReconciliationAudit {
  const now = input.now || new Date();
  const terminalRecords = input.rides
    .map(financialRideRecord)
    .filter((record): record is RideFinancialRecord => record !== null);
  const summary = summarizeRideFinancials(terminalRecords);
  const rawRides = new Map(input.rides.map((ride) => [String(ride.id || ''), ride]));
  const confirmedCompleted = terminalRecords.filter((record) => record.status === 'completed' && record.fareSource !== 'legacy_quote_estimate' && record.fareSource !== 'unavailable');
  const settlementIds = new Set<string>();

  let walletFundedCompletedRides = 0;
  let expectedSettlementTotal = 0;
  let fullyMatchedRides = 0;
  let riderDebitTotal = 0;
  let driverCreditTotal = 0;
  let missingSettlementRides = 0;
  let duplicateSettlementRides = 0;
  let amountMismatchRides = 0;
  let unexpectedNonWalletSettlementRides = 0;

  for (const record of confirmedCompleted) {
    const rawRide = rawRides.get(record.id) || {};
    const settlements = rideSettlementRecords(record.id, input.walletTransactions);
    settlements.forEach((transaction) => settlementIds.add(String(transaction.id || '')));
    const riderDebits = settlements.filter((transaction) => String(transaction.type || '').toLowerCase() === 'debit');
    const driverCredits = settlements.filter((transaction) => String(transaction.type || '').toLowerCase() === 'credit');
    const debitAmount = money(riderDebits.reduce((total, transaction) => total + nonNegative(transaction.amount), 0));
    const creditAmount = money(driverCredits.reduce((total, transaction) => total + nonNegative(transaction.amount), 0));
    const hasAnySettlement = settlements.length > 0;

    if (!isWalletFunded(rawRide)) {
      if (hasAnySettlement) unexpectedNonWalletSettlementRides += 1;
      continue;
    }

    walletFundedCompletedRides += 1;
    expectedSettlementTotal += record.totalRideCharge;
    riderDebitTotal += debitAmount;
    driverCreditTotal += creditAmount;
    if (!hasAnySettlement) {
      missingSettlementRides += 1;
      continue;
    }
    if (riderDebits.length !== 1 || driverCredits.length !== 1) duplicateSettlementRides += 1;
    if (debitAmount !== record.totalRideCharge || creditAmount !== record.totalRideCharge) amountMismatchRides += 1;
    if (riderDebits.length === 1 && driverCredits.length === 1 && debitAmount === record.totalRideCharge && creditAmount === record.totalRideCharge) {
      fullyMatchedRides += 1;
    }
  }

  let completedCount = 0;
  let completedAmount = 0;
  let processingCount = 0;
  let processingAmount = 0;
  let failedCount = 0;
  let failedAmount = 0;
  let staleProcessingCount = 0;
  let staleProcessingAmount = 0;

  for (const transaction of input.walletTransactions) {
    const amount = nonNegative(transaction.amount);
    const status = walletTransactionStatus(transaction);
    if (status === 'completed') {
      completedCount += 1;
      completedAmount += amount;
    } else if (status === 'processing') {
      processingCount += 1;
      processingAmount += amount;
      const createdAt = transactionDate(transaction);
      if (createdAt !== null && now.getTime() - createdAt > STALE_PROCESSING_MS) {
        staleProcessingCount += 1;
        staleProcessingAmount += amount;
      }
    } else if (status === 'failed') {
      failedCount += 1;
      failedAmount += amount;
    }
  }

  const orphanSettlementRecords = input.walletTransactions.filter((transaction) => {
    const reference = String(transaction.reference || '');
    const linkedRideId = String(transaction.ride_id || '');
    const isSettlement = reference.startsWith('hy3n-ride-') || Boolean(linkedRideId && reference.startsWith('hy3n-ride-'));
    return isSettlement && !settlementIds.has(String(transaction.id || ''));
  }).length;

  const exceptions: FinancialReconciliationAudit['exceptions'] = [];
  const addException = (code: string, count: number, amount?: number) => {
    if (count > 0) exceptions.push({ code, count, ...(amount && amount > 0 ? { amount: money(amount) } : {}) });
  };
  addException('missing_wallet_settlement', missingSettlementRides, expectedSettlementTotal - riderDebitTotal);
  addException('duplicate_wallet_settlement', duplicateSettlementRides);
  addException('wallet_settlement_amount_mismatch', amountMismatchRides, Math.abs(expectedSettlementTotal - riderDebitTotal));
  addException('unexpected_non_wallet_settlement', unexpectedNonWalletSettlementRides);
  addException('orphan_wallet_settlement_record', orphanSettlementRecords);
  addException('stale_processing_wallet_transaction', staleProcessingCount, staleProcessingAmount);

  const attentionCount = summary.legacyQuoteEstimateRides;
  const exceptionCount = exceptions.reduce((total, exception) => total + exception.count, 0);
  const status: ReconciliationStatus = exceptionCount > 0 ? 'exception' : attentionCount > 0 ? 'attention' : 'passed';

  return {
    runDate: input.runDate || dateInGhana(now),
    executedAt: now.toISOString(),
    status,
    exceptionCount,
    attentionCount,
    sourceTruncated: false,
    rideLedger: {
      terminalRecords: summary.records,
      completedRides: summary.completedRides,
      confirmedCompletedRides: summary.confirmedCompletedRides,
      confirmedChargeTotal: summary.totalRideCharge,
      waitingFeeTotal: summary.waitingFeeTotal,
      tipAmountTotal: summary.tipAmountTotal,
      cancelledRides: summary.cancelledRides,
      cancellationPenaltyTotal: summary.cancellationPenaltyTotal,
      legacyQuoteEstimateRides: summary.legacyQuoteEstimateRides,
      legacyQuoteEstimateTotal: summary.legacyQuoteEstimateTotal,
    },
    walletSettlement: {
      walletFundedCompletedRides,
      expectedSettlementTotal: money(expectedSettlementTotal),
      fullyMatchedRides,
      riderDebitTotal: money(riderDebitTotal),
      driverCreditTotal: money(driverCreditTotal),
      missingSettlementRides,
      duplicateSettlementRides,
      amountMismatchRides,
      unexpectedNonWalletSettlementRides,
      orphanSettlementRecords,
    },
    walletTransactions: {
      completedCount,
      completedAmount: money(completedAmount),
      processingCount,
      processingAmount: money(processingAmount),
      failedCount,
      failedAmount: money(failedAmount),
      staleProcessingCount,
      staleProcessingAmount: money(staleProcessingAmount),
    },
    exceptions,
  };
}

/** Runs once per Ghana calendar day and writes only an aggregate, no-PII audit. */
export async function runDailyFinancialReconciliation(now = new Date()): Promise<FinancialReconciliationAudit> {
  const [rideResult, walletResult] = await Promise.all([
    adminFirestore.listAll(ADMIN_COLLECTIONS.RIDES),
    adminFirestore.listAll(ADMIN_COLLECTIONS.WALLET_TRANSACTIONS),
  ]);
  const audit = reconcileFinancialRecords({ rides: rideResult.records, walletTransactions: walletResult.records, now });
  audit.sourceTruncated = rideResult.truncated || walletResult.truncated;
  if (audit.sourceTruncated) {
    audit.exceptions.push({ code: 'source_collection_limit_reached', count: 1 });
    audit.exceptionCount += 1;
    audit.status = 'exception';
  }
  await adminFirestore.set(ADMIN_COLLECTIONS.FINANCIAL_RECONCILIATION_AUDITS, audit.runDate, {
    ...audit,
    audit_type: 'daily_financial_ledger_wallet_reconciliation',
    time_zone: GHANA_TIME_ZONE,
    source: 'firebase_scheduled_function',
  });
  console.info('[Financial reconciliation] Daily audit completed', {
    runDate: audit.runDate,
    status: audit.status,
    exceptionCount: audit.exceptionCount,
    attentionCount: audit.attentionCount,
  });
  return audit;
}
