/**
 * HY3N Hubtel Payment Service
 *
 * Handles Hubtel Direct Receive Money (mobile money) charges — used for
 * Driver daily fees, Rider wallet top-ups, and the public payments API.
 * Credentials are injected as Firebase Function secrets and are never exposed
 * to a mobile client or printed in logs.
 */

import {
  hubtelPaymentState,
  isHubtelChargeInitiated,
  isHubtelStatusResponseAccepted,
  readHubtelPaymentDetails,
} from './hubtelPaymentStatus';

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
  /** Optional callback destination for payment-type-specific settlement. */
  callbackUrl?: string;
}

export interface HubtelChargeResponse {
  success: boolean;
  /** Hubtel transaction reference */
  transactionId?: string;
  /** "pending" | "paid" | "failed" */
  status?: 'pending' | 'paid' | 'failed';
  message?: string;
  /** Raw provider response for protected server-side handling only. */
  raw?: unknown;
}

const HUBTEL_POS_NUMBER = process.env.HUBTEL_POS_NUMBER || '';
const HUBTEL_API_ID = process.env.HUBTEL_API_ID || '';
const HUBTEL_API_KEY = process.env.HUBTEL_API_KEY || '';

function getBasicAuth(): string {
  const credentials = `${HUBTEL_API_ID}:${HUBTEL_API_KEY}`;
  return 'Basic ' + Buffer.from(credentials).toString('base64');
}

function phoneNumberFormat(msisdn: string): string {
  // Hubtel Direct Receive accepts Ghana's local MSISDN form. Accept the app's
  // common local, 233, and +233 variants and pass one predictable format.
  const digits = String(msisdn || '').replace(/\D/g, '');
  if (digits.startsWith('233') && digits.length === 12) return `0${digits.slice(3)}`;
  if (digits.length === 9) return `0${digits}`;
  return digits;
}

function paymentErrorMessage(data: unknown, httpStatus: number): string {
  const message = readHubtelPaymentDetails(data).message;
  return message || `Payment provider request failed (${httpStatus}).`;
}

/**
 * Initiate a direct MoMo charge via the existing Hubtel merchant endpoint.
 *
 * The endpoint accepts both legacy and current Hubtel response envelopes. A
 * provider acknowledgement starts a payment; only a confirmed terminal status
 * settles a wallet or unlocks a Driver fee gate.
 */
export async function chargeDriverCommission(req: HubtelChargeRequest): Promise<HubtelChargeResponse> {
  const callbackUrl = req.callbackUrl || process.env.PRIMARY_CALLBACK_URL || '';
  if (!HUBTEL_POS_NUMBER || !HUBTEL_API_ID || !HUBTEL_API_KEY || !callbackUrl) {
    console.error('[Hubtel] Direct Receive configuration is incomplete.');
    return { success: false, status: 'failed', message: 'Payment provider is not configured.' };
  }

  const url = `https://rmp.hubtel.com/merchantaccount/merchants/${HUBTEL_POS_NUMBER}/receive/mobilemoney`;
  const body = {
    CustomerMsisdn: phoneNumberFormat(req.customerMsisdn),
    Amount: req.amount,
    CustomerName: req.customerName,
    Description: req.description,
    ClientReference: req.clientReference,
    Channel: req.channel,
    PrimaryCallbackUrl: callbackUrl,
  };

  // Do not log request headers, credentials, names, phone numbers, references,
  // or provider payloads. Their protected records remain available to the
  // payment provider and to authorized administrators when needed.
  console.log('[Hubtel] Starting Direct Receive request.');

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: getBasicAuth(),
        'Cache-Control': 'no-cache',
      },
      body: JSON.stringify(body),
    });

    const rawText = await response.text();
    let data: unknown = {};
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      data = {};
    }

    const details = readHubtelPaymentDetails(data);
    const state = hubtelPaymentState(data);
    console.log('[Hubtel] Direct Receive response:', {
      httpStatus: response.status,
      responseCode: details.responseCode || 'none',
      paymentState: state,
    });

    if (!response.ok) {
      console.error('[Hubtel] Direct Receive request was rejected:', response.status);
      return {
        success: false,
        status: 'failed',
        message: paymentErrorMessage(data, response.status),
        raw: data,
      };
    }

    // Hubtel Direct Receive returns `0000`/`0001` in older accounts and `00`
    // in current response envelopes. Never treat HTTP 2xx alone as accepted;
    // a provider-declared terminal failure remains a failed request.
    const accepted = isHubtelChargeInitiated(data);
    return {
      success: accepted,
      transactionId: details.transactionId || details.clientReference || req.clientReference,
      status: accepted ? (state === 'paid' ? 'paid' : 'pending') : 'failed',
      message: details.message || (accepted ? 'Charge initiated. Awaiting MoMo approval.' : 'Charge failed.'),
      raw: data,
    };
  } catch (err: any) {
    const networkMessage = err?.message || 'Network error contacting payment provider.';
    // A terminated response can follow a valid Direct Receive request. Check the
    // status endpoint briefly before reporting the initiation as failed.
    console.error('[Hubtel] Direct Receive network error. Attempting status recovery.');
    try {
      for (const delayMs of [0, 500, 1000, 2000]) {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        const statusResponse = await transactionStatusCheck(req.clientReference);
        const state = hubtelPaymentState(statusResponse);
        const details = readHubtelPaymentDetails(statusResponse);
        if (isHubtelStatusResponseAccepted(statusResponse) && state !== 'failed') {
          console.warn('[Hubtel] Recovered Direct Receive state after a terminated initiation connection.', { paymentState: state });
          return {
            success: true,
            transactionId: details.transactionId || req.clientReference,
            status: state === 'paid' ? 'paid' : 'pending',
            message: state === 'paid' ? 'Payment completed.' : 'Charge initiated. Awaiting MoMo approval.',
            raw: statusResponse,
          };
        }
        if (isHubtelStatusResponseAccepted(statusResponse) && state === 'failed') break;
      }
    } catch {
      console.error('[Hubtel] Direct Receive status recovery was unavailable.');
    }

    return { success: false, status: 'failed', message: networkMessage };
  }
}

/** Query a Direct Receive payment using the merchant's client reference. */
export async function transactionStatusCheck(clientReference: string) {
  if (!HUBTEL_POS_NUMBER || !HUBTEL_API_ID || !HUBTEL_API_KEY) {
    console.error('[Hubtel] Direct Receive status configuration is incomplete.');
    return { success: false, status: 'failed', message: 'Payment provider is not configured.' };
  }

  const url = `https://api-txnstatus.hubtel.com/transactions/${HUBTEL_POS_NUMBER}/status?clientReference=${encodeURIComponent(clientReference)}`;
  console.log('[Hubtel] Checking Direct Receive transaction status.');
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: getBasicAuth(),
        'Cache-Control': 'no-cache',
      },
    });

    const rawText = await response.text();
    let data: unknown = {};
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      data = {};
    }

    if (!response.ok) {
      console.error('[Hubtel] Direct Receive status check was rejected:', response.status);
      return { success: false, status: 'failed', message: paymentErrorMessage(data, response.status), raw: data };
    }

    const details = readHubtelPaymentDetails(data);
    console.log('[Hubtel] Direct Receive status response:', {
      responseCode: details.responseCode || 'none',
      paymentState: hubtelPaymentState(data),
    });
    return data;
  } catch (err: any) {
    console.error('[Hubtel] Direct Receive status check had a network error.');
    return { success: false, status: 'failed', message: err?.message || 'Network error contacting payment provider.' };
  }
}

/** Determine commission amount based on driver service type. */
export function getCommissionAmount(_serviceType: string): number {
  // The operational rate is loaded from the protected platform fee setting;
  // retain this legacy helper for code paths that still import it.
  return 50;
}

/** Determine Hubtel channel from a supplied Ghana network name. */
export function getMomoChannel(network: string): 'mtn-gh' | 'vodafone-gh' | 'tigo-gh' {
  const lower = (network || '').toLowerCase();
  if (lower.includes('vodafone') || lower.includes('telecel')) return 'vodafone-gh';
  if (lower.includes('tigo') || lower.includes('airtel') || lower.includes('airteltigo') || lower.includes('at')) return 'tigo-gh';
  return 'mtn-gh';
}

/** Generate a deterministic daily commission reference for legacy callers. */
export function getCommissionReference(driverId: string, date?: string): string {
  const d = date || new Date().toISOString().split('T')[0];
  return `c-${driverId}-${d}`;
}
