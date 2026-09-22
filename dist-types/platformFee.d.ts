export declare const DEFAULT_DAILY_PLATFORM_FEE = 50;
export type PlatformFeeSetting = {
    amount: number;
    updatedAt: string | null;
    updatedBy: string | null;
    source: 'firestore' | 'default';
};
/**
 * Loads the platform fee at charge time. This must not be cached in process
 * memory: multiple Railway replicas must always use the same admin setting.
 */
export declare function getDailyPlatformFee(): Promise<PlatformFeeSetting>;
/**
 * Persists a single global fee so all driver service types receive the same
 * fixed daily charge. Validation occurs again on the server before any write.
 */
export declare function setDailyPlatformFee(amountInput: number, updatedBy: string): Promise<PlatformFeeSetting>;
