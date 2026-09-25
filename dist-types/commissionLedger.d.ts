export type CommissionLedgerRecord = Record<string, any>;
export type CommissionLedgerStatus = 'paid' | 'processing' | 'failed' | 'other';
export declare function commissionLedgerStatus(value: unknown): CommissionLedgerStatus;
export declare function commissionLedgerDate(record: CommissionLedgerRecord): string;
export declare function filterCommissionLedger(records: CommissionLedgerRecord[], filters: {
    dateFrom?: string;
    dateTo?: string;
    status?: string;
}): CommissionLedgerRecord[];
export declare function summarizeCommissionLedger(records: CommissionLedgerRecord[], today: string): {
    records: number;
    paidCount: number;
    processingCount: number;
    failedCount: number;
    paidAmount: number;
    processingAmount: number;
    failedAmount: number;
    todayPaidAmount: number;
};
