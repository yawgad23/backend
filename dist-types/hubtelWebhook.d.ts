/**
 * Hubtel Webhook Handlers
 *
 * Receives payment confirmation callbacks from Hubtel and updates the
 * relevant Firestore record. Hubtel sends a POST with:
 * {
 *   "TransactionId": "string",
 *   "Amount": number,
 *   "Status": "Success" | "Failed" | "Pending",
 *   "Message": "string",
 *   "ClientReference": "string",
 *   "Timestamp": "ISO string"
 * }
 *
 * Three reference formats are routed to three different collections:
 *   - "hy3n-commission-{driverId}-{date}"  -> daily_commissions   (driver commission)
 *   - "hy3n-topup-{riderId}-{timestamp}"   -> wallet_transactions (rider wallet top-up)
 *   - anything else (e.g. "hy3n-pub-...")  -> payments            (public payments API)
 */
import { Express, Request, Response } from 'express';
export interface HubtelWebhookPayload {
    TransactionId?: string;
    Amount?: number;
    Status?: 'Success' | 'Failed' | 'Pending';
    Message?: string;
    ClientReference?: string;
    Timestamp?: string;
    [key: string]: any;
}
/**
 * Handle driver daily-commission webhook callback.
 */
export declare function handleHubtelWebhook(req: Request, res: Response): Promise<void>;
/**
 * Handle Hubtel wallet top-up webhook callback.
 * Credits the rider/driver wallet when Hubtel confirms payment.
 */
export declare function handleHubtelWalletWebhook(req: Request, res: Response): Promise<void>;
/**
 * Register the Hubtel webhook endpoints.
 */
export declare function registerHubtelWebhook(app: Express): void;
