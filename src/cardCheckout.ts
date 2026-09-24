import { randomUUID } from 'node:crypto';

/**
 * Server-only Hubtel Online Checkout integration.
 *
 * Card details are never accepted by HY3N. The server creates a Hubtel invoice
 * using its merchant credentials and returns Hubtel's hosted checkout URL to
 * the authenticated Rider app.
 */

const HUBTEL_POS_NUMBER = process.env.HUBTEL_POS_NUMBER || '';
const HUBTEL_API_ID = process.env.HUBTEL_API_ID || '';
const HUBTEL_API_KEY = process.env.HUBTEL_API_KEY || '';
const HUBTEL_ONLINE_CHECKOUT_BASE_URL = 'https://api.hubtel.com/v1/merchantaccount/onlinecheckout';

export type CardCheckoutState = 'processing' | 'paid' | 'failed';

export interface CardCheckoutRequest {
  amount: number;
  customerName: string;
  reference: string;
  description: string;
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

function basicAuth(): string {
  return `Basic ${Buffer.from(`${HUBTEL_API_ID}:${HUBTEL_API_KEY}`).toString('base64')}`;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function nestedString(payload: Record<string, any>, keys: string[]): string | undefined {
  for (const source of [payload, payload.Data, payload.data, payload.invoice, payload.Invoice]) {
    if (!source || typeof source !== 'object') continue;
    for (const key of keys) {
      const value = stringValue(source[key]);
      if (value) return value;
    }
  }
  return undefined;
}

function firstHostedUrl(payload: Record<string, any>): string | undefined {
  const direct = nestedString(payload, [
    'checkoutUrl', 'checkout_url', 'paymentUrl', 'payment_url', 'url', 'redirectUrl', 'redirect_url',
  ]);
  if (direct && /^https:\/\//i.test(direct)) return direct;

  // Legacy Hubtel Online Checkout returns the redirect URL in response_text.
  const responseText = nestedString(payload, ['response_text', 'ResponseText', 'message', 'Message']);
  if (responseText && /^https:\/\//i.test(responseText)) return responseText;
  return undefined;
}

function providerStatus(payload: Record<string, any>): string | undefined {
  return nestedString(payload, [
    'status', 'Status', 'paymentStatus', 'payment_status', 'invoiceStatus', 'invoice_status',
  ]);
}

function transactionId(payload: Record<string, any>): string | undefined {
  return nestedString(payload, [
    'transactionId', 'TransactionId', 'transaction_id', 'TransactionID', 'paymentId', 'payment_id',
  ]);
}

function providerMessage(payload: Record<string, any>): string | undefined {
  return nestedString(payload, [
    'message', 'Message', 'description', 'Description', 'response_text', 'ResponseText',
  ]);
}

async function responseJson(response: Response): Promise<Record<string, any>> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, any>;
  } catch {
    return { rawText: text.slice(0, 1000) };
  }
}

function paymentState(payload: Record<string, any>): CardCheckoutState {
  const state = String(providerStatus(payload) || '').trim().toLowerCase();
  if (['paid', 'success', 'successful', 'completed', 'complete'].includes(state)) return 'paid';
  if (['failed', 'failure', 'declined', 'cancelled', 'canceled', 'expired', 'reversed'].includes(state)) return 'failed';
  return 'processing';
}

function canUseHubtelCardCheckout(): boolean {
  return Boolean(HUBTEL_POS_NUMBER && HUBTEL_API_ID && HUBTEL_API_KEY);
}

export function createCardCheckoutReference(): string {
  return `hy3n-card-${randomUUID().replaceAll('-', '').slice(0, 24)}`;
}

export function parseCardCheckoutState(payload: Record<string, any>): CardCheckoutState {
  return paymentState(payload);
}

export function hostedCheckoutUrlFromPayload(payload: Record<string, any>): string | undefined {
  return firstHostedUrl(payload);
}

export async function initiateHubtelCardCheckout(request: CardCheckoutRequest): Promise<CardCheckoutCreation> {
  if (!canUseHubtelCardCheckout()) {
    return { success: false, message: 'Card payments are not configured yet.' };
  }

  const amount = Math.round(request.amount * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) {
    return { success: false, message: 'The card payment amount is invalid.' };
  }

  const body = {
    invoice: {
      total_amount: amount,
      description: request.description,
      items: [{
        name: 'HY3N ride credit',
        description: request.description,
        quantity: 1,
        unit_price: amount,
        total_price: amount,
      }],
    },
    store: {
      name: 'HY3N',
      tagline: 'Safe, reliable rides',
      phone: '0557278990',
    },
    actions: {
      return_url: request.returnUrl,
      cancel_url: request.returnUrl,
    },
    custom_data: {
      client_reference: request.reference,
      reference: request.reference,
      source: 'hy3n_rider_card_checkout',
    },
  };

  try {
    const response = await fetch(`${HUBTEL_ONLINE_CHECKOUT_BASE_URL}/invoice/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: basicAuth(),
        'Cache-Control': 'no-cache',
      },
      body: JSON.stringify(body),
    });
    const payload = await responseJson(response);
    const checkoutUrl = firstHostedUrl(payload);
    const token = nestedString(payload, ['token', 'Token', 'checkoutToken', 'checkout_token']);
    const responseCode = nestedString(payload, ['response_code', 'ResponseCode', 'code', 'Code']);

    if (!response.ok) {
      console.error('[Hubtel Card] Checkout creation failed', { status: response.status, responseCode, payload });
      return {
        success: false,
        message: providerMessage(payload) || `Hubtel returned HTTP ${response.status}.`,
        raw: payload,
      };
    }

    if (!checkoutUrl) {
      console.error('[Hubtel Card] Checkout response did not include a hosted URL', { responseCode, token, payload });
      return {
        success: false,
        message: 'Hubtel did not return a secure card checkout link. Please contact HY3N support.',
        raw: payload,
      };
    }

    return {
      success: true,
      checkoutUrl,
      token,
      providerStatus: providerStatus(payload),
      message: providerMessage(payload),
      raw: payload,
    };
  } catch (error: any) {
    console.error('[Hubtel Card] Checkout creation network error', error?.message);
    return { success: false, message: 'Unable to contact Hubtel for card checkout. Please try again.' };
  }
}

export async function checkHubtelCardCheckout(token: string): Promise<CardCheckoutStatus> {
  if (!canUseHubtelCardCheckout()) {
    return { success: false, state: 'failed', message: 'Card payments are not configured yet.' };
  }
  if (!token.trim()) {
    return { success: false, state: 'failed', message: 'The card payment reference is missing.' };
  }

  try {
    const response = await fetch(`${HUBTEL_ONLINE_CHECKOUT_BASE_URL}/invoice/status/${encodeURIComponent(token)}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: basicAuth(),
        'Cache-Control': 'no-cache',
      },
    });
    const payload = await responseJson(response);
    if (!response.ok) {
      console.error('[Hubtel Card] Checkout status failed', { status: response.status, payload });
      return {
        success: false,
        state: 'processing',
        message: providerMessage(payload) || `Hubtel returned HTTP ${response.status}.`,
        raw: payload,
      };
    }

    return {
      success: true,
      state: paymentState(payload),
      providerStatus: providerStatus(payload),
      transactionId: transactionId(payload),
      message: providerMessage(payload),
      raw: payload,
    };
  } catch (error: any) {
    console.error('[Hubtel Card] Checkout status network error', error?.message);
    return { success: false, state: 'processing', message: 'Unable to confirm the card payment yet.' };
  }
}
