export type HubtelPaymentState = 'paid' | 'failed' | 'processing';

export type HubtelPaymentDetails = {
  responseCode: string;
  status: string;
  message: string;
  transactionId: string;
  clientReference: string;
};

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value === null || value === undefined ? '' : String(value).trim();
}

function folded(value: unknown): string {
  return text(value).toLowerCase();
}

function responseData(payload: Record<string, unknown>): Record<string, unknown> {
  const candidate = payload.Data ?? payload.data;
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : {};
}

/**
 * Normalizes both Hubtel response shapes used by deployed integrations:
 * legacy `0000` / `0001` responses and current `00` responses, with either
 * top-level fields or a `Data` / `data` object. A response code alone never
 * credits a payment—the terminal provider status still controls settlement.
 */
export function readHubtelPaymentDetails(input: unknown): HubtelPaymentDetails {
  const payload = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const data = responseData(payload);

  return {
    responseCode: text(payload.ResponseCode ?? payload.responseCode ?? data.ResponseCode ?? data.responseCode),
    status: text(data.Status ?? data.status ?? payload.Status ?? payload.status),
    message: text(data.Message ?? data.message ?? payload.Message ?? payload.message ?? payload.ResponseMessage ?? payload.responseMessage),
    transactionId: text(data.TransactionId ?? data.transactionId ?? payload.TransactionId ?? payload.transactionId ?? data.OrderId ?? data.orderId),
    clientReference: text(data.ClientReference ?? data.clientReference ?? payload.ClientReference ?? payload.clientReference),
  };
}

export function isHubtelAcceptedResponseCode(value: unknown): boolean {
  return ['00', '0000', '0001'].includes(text(value));
}

export function hubtelPaymentState(input: unknown): HubtelPaymentState {
  const details = readHubtelPaymentDetails(input);
  const status = folded(details.status || details.message);

  if (['paid', 'success', 'successful', 'succeeded', 'completed', 'complete'].includes(status)) {
    return 'paid';
  }
  if (['failed', 'declined', 'rejected', 'cancelled', 'canceled', 'expired', 'timeout', 'timedout', 'timed out', 'reversed'].includes(status)) {
    return 'failed';
  }
  return 'processing';
}

/** A Direct Receive request is accepted when Hubtel acknowledges it and has not returned a terminal failure. */
export function isHubtelChargeInitiated(input: unknown): boolean {
  const details = readHubtelPaymentDetails(input);
  return isHubtelAcceptedResponseCode(details.responseCode) && hubtelPaymentState(input) !== 'failed';
}

export function isHubtelStatusResponseAccepted(input: unknown): boolean {
  return isHubtelAcceptedResponseCode(readHubtelPaymentDetails(input).responseCode);
}
