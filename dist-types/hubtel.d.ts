/**
 * HY3N Hubtel Payment Service
 *
 * Handles Hubtel Direct Receive Money (mobile money) charges — used for
 * driver daily commission deduction, rider wallet top-ups, and the public
 * payments API.
 *
 * API endpoint:
 *   POST https://rmp.hubtel.com/merchantaccount/merchants/{POS_SALES_NUMBER}/receive/mobilemoney
 *
 * Auth: Basic base64(API_ID:API_KEY)
 *
 * Credentials are read from HUBTEL_POS_NUMBER / HUBTEL_API_ID / HUBTEL_API_KEY
 * in .env (never hardcode real values here — this file is committed to git).
 *
 * IMPORTANT: The "Receive Money" scope must be enabled on the API key by Hubtel.
 * Email retail@hubtel.com to request this scope. Also provide your server IP for whitelisting.
 *
 * Commission rates:
 *   - Car drivers (Standard/Comfort/Kantanka/Executive): GH₵50/day
 *   - Okada / Delivery drivers: GH₵30/day
 */
export interface HubtelChargeRequest {
    /** Customer's MoMo phone number (e.g. "0244123456") */
    customerMsisdn: string;
    /** Amount in GH₵ */
    amount: number;
    /** Customer's full name */
    customerName: string;
    /** Description shown on the USSD prompt */
    description: string;
    /** Unique reference for idempotency */
    clientReference: string;
    /** MoMo network channel: "mtn-gh" | "vodafone-gh" | "tigo-gh" */
    channel: 'mtn-gh' | 'vodafone-gh' | 'tigo-gh';
}
export interface HubtelChargeResponse {
    success: boolean;
    /** Hubtel transaction reference */
    transactionId?: string;
    /** "pending" | "success" | "failed" */
    status?: string;
    message?: string;
    /** Raw response from Hubtel for debugging */
    raw?: any;
}
/**
 * Initiate a direct MoMo charge via Hubtel.
 * The customer receives a USSD prompt on their phone to approve the payment.
 */
export declare function chargeDriverCommission(req: HubtelChargeRequest): Promise<HubtelChargeResponse>;
/**
 * Determine commission amount based on driver service type.
 */
export declare function getCommissionAmount(serviceType: string): number;
/**
 * Determine Hubtel channel from MoMo network name.
 */
export declare function getMomoChannel(network: string): 'mtn-gh' | 'vodafone-gh' | 'tigo-gh';
/**
 * Generate a unique idempotency reference for a driver's daily commission.
 * Format: hy3n-commission-{driverId}-{YYYY-MM-DD}
 */
export declare function getCommissionReference(driverId: string, date?: string): string;
