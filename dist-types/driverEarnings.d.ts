export type DriverEarningsPeriod = 'today' | 'week' | 'month';
type DatedRecord = Record<string, unknown>;
export declare function isRecordInEarningsPeriod(record: DatedRecord, period: DriverEarningsPeriod, referenceDate?: Date, dateFields?: string[]): boolean;
export declare function completedRidesForPeriod(rides: DatedRecord[], period: DriverEarningsPeriod, referenceDate?: Date): DatedRecord[];
export declare function paidFeesForPeriod(fees: DatedRecord[], period: DriverEarningsPeriod, referenceDate?: Date): DatedRecord[];
export declare function numericRideFare(ride: DatedRecord): number;
export declare function numericTip(ride: DatedRecord): number;
export declare function earningsTrend(rides: DatedRecord[], maxDays?: number): {
    date: string;
    amount: number;
}[];
export {};
