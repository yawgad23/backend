export type CardCheckoutState = 'processing' | 'paid' | 'failed';
export interface CardCheckoutRequest {
    amount: number;
    customerName: string;
    reference: string;
    description: string;
    callbackUrl: string;
    returnUrl: string;
}
export interface CardCheckoutCreation {
    success: boolean;
    checkoutUrl?: string;
    token?: string;
    providerStatus?: string;
    message?: string;
    raw?: Record<string, unknown>;
}
export interface CardCheckoutStatus {
    success: boolean;
    state: CardCheckoutState;
    providerStatus?: string;
    transactionId?: string;
    message?: string;
    raw?: Record<string, unknown>;
}
export declare function createCardCheckoutReference(): string;
export declare function parseCardCheckoutState(payload: Record<string, any>): CardCheckoutState;
export declare function hostedCheckoutUrlFromPayload(payload: Record<string, any>): string | undefined;
/**
 * Hubtel Sales Checkout creates the payment session server-side.  The app is
 * given only the one-time hosted URL and never receives merchant credentials
 * or handles a card number, expiry date, CVV, or saved card token.
 */
export declare function buildHubtelCardCheckoutPayload(request: CardCheckoutRequest): Record<string, unknown>;
export declare function initiateHubtelCardCheckout(request: CardCheckoutRequest): Promise<CardCheckoutCreation>;
export declare function checkHubtelCardCheckout(token: string): Promise<CardCheckoutStatus>;
