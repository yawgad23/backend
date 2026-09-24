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
 * Platform fee:
 *   - All drivers: GH₵50/day
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
  /** Optional callback destination for payment-type-specific settlement. */
  callbackUrl?: string;
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
  // Hubtel Receive Money accepts Ghana's local MSISDN form (for example,
  // 0557278990). Accept the app's common local, 233, and +233 variants and
  // pass one predictable format to Hubtel.
  const digits = String(msisdn || '').replace(/\D/g, '');
  if (digits.startsWith('233') && digits.length === 12) {
    return `0${digits.slice(3)}`;
  }
  if (digits.length === 9) return `0${digits}`;
  return digits;
}


/**
 * Initiate a direct MoMo charge via Hubtel.
 * The customer receives a USSD prompt on their phone to approve the payment.
 */
export async function chargeDriverCommission(req: HubtelChargeRequest): Promise<HubtelChargeResponse> {
  const callbackUrl = req.callbackUrl || process.env.PRIMARY_CALLBACK_URL || '';
  if (!HUBTEL_POS_NUMBER || !HUBTEL_API_ID || !HUBTEL_API_KEY || !callbackUrl) {
    console.error('[Hubtel] Missing HUBTEL_POS_NUMBER, HUBTEL_API_ID, HUBTEL_API_KEY, or PRIMARY_CALLBACK_URL.');
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

    // Hubtel returns "0001" when it has accepted a direct-receive request
    // and the payer must still approve it on their phone. "0000"/"Success"
    // is the completed success state returned by some endpoints. A bare HTTP
    // 200 is not enough because it can still contain a provider-side error.
    const isSuccess = data?.ResponseCode === '0000'
      || data?.ResponseCode === '0001'
      || data?.Status === 'Success';
    const transactionId = data?.Data?.TransactionId || data?.TransactionId || data?.ClientReference;

    return {
      success: isSuccess,
      transactionId,
      status: isSuccess ? 'pending' : 'failed',
      message: data?.Message || data?.message || (isSuccess ? 'Charge initiated' : 'Charge failed'),
      raw: data,
    };
  } catch (err: any) {
    const networkMessage = err?.message || 'Network error contacting Hubtel';
    // Hubtel can create the Direct Receive transaction and then close the
    // initiation connection before Node receives the HTTP response. A closed
    // connection therefore does not always mean that the charge failed. Check
    // the transaction-status endpoint before reporting a failure to the app.
    console.error('[Hubtel] Network error:', networkMessage);
    try {
      const statusResponse: any = await transactionStatusCheck(req.clientReference);
      const responseCode = String(statusResponse?.responseCode || statusResponse?.ResponseCode || '');
      const data = statusResponse?.data || statusResponse?.Data || {};
      const providerStatus = String(data.status || data.Status || '').toLowerCase();
      const terminalFailureStates = new Set(['failed', 'declined', 'cancelled', 'canceled', 'expired', 'reversed']);

      if (responseCode === '0000' && !terminalFailureStates.has(providerStatus)) {
        const transactionId = data.transactionId || data.TransactionId || data.orderId || data.OrderId;
        console.warn('[Hubtel] Recovered accepted transaction after terminated initiation connection:', {
          clientReference: req.clientReference,
          transactionId,
          providerStatus,
        });
        return {
          success: true,
          transactionId,
          status: 'pending',
          message: 'Charge initiated. Awaiting MoMo approval.',
          raw: statusResponse,
        };
      }
    } catch (statusError: any) {
      console.error('[Hubtel] Status recovery after network error failed:', statusError?.message);
    }

    return {
      success: false,
      status: 'failed',
      message: networkMessage,
    };
  }
}

export async function transactionStatusCheck(clientReference: string){
  if (!HUBTEL_POS_NUMBER || !HUBTEL_API_ID || !HUBTEL_API_KEY) {
    console.error('[Hubtel] Cannot check transaction status: Hubtel credentials are not configured.');
    return { success: false, status: 'failed', message: 'Payment provider is not configured.' };
  }

  const url = `https://api-txnstatus.hubtel.com/transactions/${HUBTEL_POS_NUMBER}/status?clientReference=${clientReference}`;
  console.log(`[Hubtel] Checking transaction status for clientReference=${clientReference} url=${url}`);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': getBasicAuth(),
        'Cache-Control': 'no-cache',
      },
    });

    const rawText = await response.text();
    let data: any = {};
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      data = {};
    }
if (!response.ok) {
      // Common error codes from Hubtel:
      // 401 = bad credentials or missing "Receive Money" scope
      // 403 = IP not whitelisted
      // 400 = invalid phone number or channel
      const errorMsg = data?.Message || data?.message || `HTTP ${response.status}`;
      console.error('[Hubtel] Status check failed:', response.status, errorMsg, data);
      return {
        success: false,
        status: 'failed',
        message: errorMsg,
        raw: data,
      };
    }

    console.log('[Hubtel] Transaction status response for ' + clientReference + ':', JSON.stringify(data, null, 2));
    return data;
  } catch (err: any) {
    console.error('[Hubtel] Transaction status network error:', err?.message);
    return { success: false, status: 'failed', message: err?.message || 'Network error contacting Hubtel' };
  }
}

/**
 * Determine commission amount based on driver service type.
 */
export function getCommissionAmount(serviceType: string): number {
  // HY3N uses one fixed daily platform fee for every driver and service type.
  // Do not allow service type or a legacy percentage/amount setting to change it.
  return 50;
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
 * Format: c-{driverId}-{YYYY-MM-DD}
 */
export function getCommissionReference(driverId: string, date?: string): string {
  const d = date || new Date().toISOString().split('T')[0];
  return `c-${driverId}-${d}`;
}
