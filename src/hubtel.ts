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

const HUBTEL_POS_NUMBER = process.env.HUBTEL_POS_NUMBER || '';
const HUBTEL_API_ID = process.env.HUBTEL_API_ID || '';
const HUBTEL_API_KEY = process.env.HUBTEL_API_KEY || '';

function getBasicAuth(): string {
  const credentials = `${HUBTEL_API_ID}:${HUBTEL_API_KEY}`;
  return 'Basic ' + Buffer.from(credentials).toString('base64');
}

/** Shows enough of the key to confirm it's the right one without printing it in full. */
function maskKey(key: string): string {
  if (key.length <= 8) return '*'.repeat(key.length);
  return `${key.slice(0, 4)}${'*'.repeat(key.length - 8)}${key.slice(-4)}`;
}

function phoneNumberFormat(msisdn: string): string {
  //check if msisdn starts with 233 if so remove it and leave the msisdn as it is
  if (msisdn.startsWith('233')) {
    msisdn = msisdn.substring(3);
    return msisdn;
  }
  return msisdn;
}


/**
 * Initiate a direct MoMo charge via Hubtel.
 * The customer receives a USSD prompt on their phone to approve the payment.
 */
export async function chargeDriverCommission(req: HubtelChargeRequest): Promise<HubtelChargeResponse> {
  if (!HUBTEL_POS_NUMBER || !HUBTEL_API_ID || !HUBTEL_API_KEY) {
    console.error('[Hubtel] Missing HUBTEL_POS_NUMBER / HUBTEL_API_ID / HUBTEL_API_KEY in .env');
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
  };

  // Logged in full so this block can be copy-pasted into a Hubtel support ticket.
  // The API key is masked — Hubtel's team can match it against the account without
  // the full secret being pasted into a ticket/chat.
  console.log('[Hubtel] >>> Request', JSON.stringify({
    timestamp: new Date().toISOString(),
    method: 'POST',
    url,
    posNumber: HUBTEL_POS_NUMBER,
    apiId: HUBTEL_API_ID,
    apiKey: maskKey(HUBTEL_API_KEY),
    body,
  }, null, 2));

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': getBasicAuth(),
        'Cache-Control': 'no-cache',
      },
      body: JSON.stringify(body),
    });

    // Read as text first — non-2xx responses (e.g. an edge/WAF block) often come
    // back as HTML, and silently swallowing that would lose the real diagnostic.
    const rawText = await response.text();
    let data: any = {};
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      data = {};
    }

    console.log('[Hubtel] <<< Response', JSON.stringify({
      timestamp: new Date().toISOString(),
      clientReference: req.clientReference,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body: data,
      rawBody: rawText,
    }, null, 2));

    if (!response.ok) {
      // Common error codes from Hubtel:
      // 401 = bad credentials or missing "Receive Money" scope
      // 403 = IP not whitelisted
      // 400 = invalid phone number or channel
      const errorMsg = data?.Message || data?.message || `HTTP ${response.status}`;
      console.error('[Hubtel] Charge failed:', response.status, errorMsg, data);
      return {
        success: false,
        status: 'failed',
        message: errorMsg,
        raw: data,
      };
    }

    // Hubtel returns ResponseCode "0000" for success
    const isSuccess = data?.ResponseCode === '0000' || data?.Status === 'Success' || response.status === 200;
    const transactionId = data?.Data?.TransactionId || data?.TransactionId || data?.ClientReference;

    return {
      success: isSuccess,
      transactionId,
      status: isSuccess ? 'pending' : 'failed',
      message: data?.Message || data?.message || (isSuccess ? 'Charge initiated' : 'Charge failed'),
      raw: data,
    };
  } catch (err: any) {
    console.error('[Hubtel] Network error:', err?.message);
    return {
      success: false,
      status: 'failed',
      message: err?.message || 'Network error contacting Hubtel',
    };
  }
}

export async function testHubtelConnection(){
 const url = 'https://webhook.site/f602e639-51c9-4c81-992a-c412fa10bd38';
const body = {

};
  const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': getBasicAuth(),
        'Cache-Control': 'no-cache',
      },
      body: JSON.stringify(body),
    });
  return response;
} 

/**
 * Determine commission amount based on driver service type.
 */
export function getCommissionAmount(serviceType: string): number {
  const lower = (serviceType || '').toLowerCase();
  if (lower.includes('okada') || lower.includes('motor') || lower.includes('delivery') || lower.includes('bike')) {
    return 30;
  }
  return 50; // All car types: standard, comfort, kantanka, executive
}

/**
 * Determine Hubtel channel from MoMo network name.
 */
export function getMomoChannel(network: string): 'mtn-gh' | 'vodafone-gh' | 'tigo-gh' {
  const lower = (network || '').toLowerCase();
  if (lower.includes('vodafone') || lower.includes('telecel')) return 'vodafone-gh';
  if (lower.includes('tigo') || lower.includes('airtel') || lower.includes('airteltigo') || lower.includes('at')) return 'tigo-gh';
  return 'mtn-gh'; // Default to MTN (most common in Ghana)
}

/**
 * Generate a unique idempotency reference for a driver's daily commission.
 * Format: hy3n-commission-{driverId}-{YYYY-MM-DD}
 */
export function getCommissionReference(driverId: string, date?: string): string {
  const d = date || new Date().toISOString().split('T')[0];
  return `hy3n-commission-${driverId}-${d}`;
}
