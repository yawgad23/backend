export type DriverApprovalState = 'approved' | 'pending' | 'rejected';
/**
 * Reads the administrator-controlled approval fields consistently across legacy
 * and current driver-profile documents. Missing or unknown values are pending:
 * a Driver must be explicitly approved before becoming dispatchable.
 */
export declare function driverApprovalState(profile: Record<string, any> | null | undefined): DriverApprovalState;
export declare function isApprovedDriverProfile(profile: Record<string, any> | null | undefined): profile is Record<string, any>;
/**
 * Profiles created by the legacy admin workflow can use an auto-generated ID,
 * while current mobile registration also maintains a UID-keyed document. Prefer
 * a currently approved document, then use the most recently changed record.
 */
export declare function driverProfileForUserId(driverId: string): Promise<Record<string, any> | null>;
export declare function approvalRequiredError(): Error;
