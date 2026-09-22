export type DriverServiceType = 'car' | 'okada' | 'delivery';
export type PlatformFeeSetting = {
    amount: number;
    serviceType: DriverServiceType;
    updatedAt: string | null;
    updatedBy: string | null;
    source: 'firestore' | 'default';
};
export declare function normalizeDriverServiceType(value: unknown): DriverServiceType;
/**
 * Loads a service-specific fee at charge time. The value is intentionally not
 * cached: every Railway replica reads the same administrator-controlled value.
 */
export declare function getDailyPlatformFee(serviceTypeInput?: unknown): Promise<PlatformFeeSetting>;
/** Persists one global daily fee per approved driver service type. */
export declare function setDailyPlatformFee(serviceTypeInput: unknown, amountInput: number, updatedBy: string): Promise<PlatformFeeSetting>;
