/**
 * Hubtel webhook handlers.
 *
 * Every handler accepts Hubtel's legacy and current payload envelopes, applies
 * the same terminal state mapping as polling, and settles wallet credit in one
 * Firestore transaction. Request headers and raw provider payloads are never
 * logged because they can contain payment and customer data.
 */

import type { Express, Request, Response } from 'express';
import { adminFirestore, ADMIN_COLLECTIONS as COLLECTIONS } from './firebaseAdmin';
import { hubtelPaymentState, readHubtelPaymentDetails } from './hubtelPaymentStatus';

export interface HubtelWebhookPayload {
  TransactionId?: string;
  Amount?: number;
  Status?: string;
  Message?: string;
  ClientReference?: string;
  Timestamp?: string;
  Data?: Record<string, unknown>;
  [key: string]: unknown;
}

function payloadDetails(rawPayload: unknown) {
  return readHubtelPaymentDetails(rawPayload);
}

function callbackState(rawPayload: unknown): 'paid' | 'failed' | 'processing' {
  return hubtelPaymentState(rawPayload);
}

function savedProviderStatus(rawPayload: unknown, fallback: string): string {
  const details = payloadDetails(rawPayload);
  return details.status || details.message || fallback;
}

function safeProviderMessage(rawPayload: unknown): string {
  return payloadDetails(rawPayload).message;
}

async function settleWalletCallback(rawPayload: unknown, res: Response): Promise<boolean> {
  const details = payloadDetails(rawPayload);
  const clientReference = details.clientReference;
  if (!clientReference) return false;

  const records = await adminFirestore.list(COLLECTIONS.WALLET_TRANSACTIONS, { reference: clientReference }, '');
  if (!records.length) {
    return false;
  }

  const record = records[0];
  const state = callbackState(rawPayload);
  const message = safeProviderMessage(rawPayload);

  if (state === 'paid') {
    const settlement = await adminFirestore.settleWalletTopUp(clientReference, {
      transactionId: details.transactionId,
      status: savedProviderStatus(rawPayload, 'Completed'),
      message,
    });
    res.json({
      success: true,
      message: settlement.settled ? 'Wallet credited' : 'Wallet top-up already settled',
      newBalance: settlement.newBalance,
    });
    return true;
  }

  if (state === 'failed') {
    await adminFirestore.update(COLLECTIONS.WALLET_TRANSACTIONS, record.id, {
      status: 'failed',
      hubtel_status: savedProviderStatus(rawPayload, 'Failed'),
      hubtel_message: message || 'Payment failed',
      updated_date: new Date().toISOString(),
    });
    res.json({ success: true, message: 'Payment marked failed' });
    return true;
  }

  res.json({ success: true, message: 'Payment is still processing' });
  return true;
}

/** Handles Driver fee callbacks and falls back to wallet or public payments. */
export async function handleHubtelWebhook(req: Request, res: Response) {
  const rawPayload = (req.body || {}) as HubtelWebhookPayload;
  const details = payloadDetails(rawPayload);
  if (!details.clientReference) {
    res.status(400).json({ error: 'Missing ClientReference' });
    return;
  }

  try {
    const commissions = await adminFirestore.list(COLLECTIONS.DAILY_COMMISSION, {
      hubtel_reference: details.clientReference,
    }, '');

    if (commissions.length) {
      const record = commissions[0];
      const state = callbackState(rawPayload);
      await adminFirestore.update(COLLECTIONS.DAILY_COMMISSION, record.id, {
        status: state,
        hubtel_webhook_received_at: new Date().toISOString(),
        hubtel_transaction_id: details.transactionId || record.hubtel_transaction_id || null,
        hubtel_status: savedProviderStatus(rawPayload, state === 'paid' ? 'Completed' : state === 'failed' ? 'Failed' : 'Pending'),
        hubtel_message: safeProviderMessage(rawPayload) || null,
      });
      console.log('[Hubtel] Processed Driver fee callback:', { paymentState: state });
      res.json({ success: true, message: 'Driver fee updated', status: state });
      return;
    }

    if (await settleWalletCallback(rawPayload, res)) return;
    await handleGenericPaymentWebhook(rawPayload, res);
  } catch {
    console.error('[Hubtel] Payment callback processing failed.');
    res.status(500).json({ error: 'Failed to process payment callback' });
  }
}

/** Dedicated wallet callback used for Rider wallet top-ups and hosted checkout. */
export async function handleHubtelWalletWebhook(req: Request, res: Response) {
  const rawPayload = (req.body || {}) as HubtelWebhookPayload;
  if (!payloadDetails(rawPayload).clientReference) {
    res.status(400).json({ error: 'Missing ClientReference' });
    return;
  }

  try {
    const handled = await settleWalletCallback(rawPayload, res);
    if (!handled) {
      res.status(404).json({ error: 'Wallet transaction record not found' });
    }
  } catch {
    console.error('[Hubtel] Wallet callback processing failed.');
    res.status(500).json({ error: 'Failed to process wallet top-up' });
  }
}

/** Handles callbacks for public payment records keyed by client reference. */
async function handleGenericPaymentWebhook(rawPayload: HubtelWebhookPayload, res: Response) {
  const details = payloadDetails(rawPayload);
  try {
    const matches = await adminFirestore.list(COLLECTIONS.PAYMENTS, { reference: details.clientReference }, '');
    const record = matches[0];
    if (!record) {
      res.status(404).json({ error: 'Unknown ClientReference' });
      return;
    }

    const state = callbackState(rawPayload);
    await adminFirestore.update(COLLECTIONS.PAYMENTS, record.id, {
      status: state === 'paid' ? 'paid' : state,
      hubtel_webhook_received_at: new Date().toISOString(),
      hubtel_transaction_id: details.transactionId || record.hubtel_transaction_id || null,
      hubtel_status: savedProviderStatus(rawPayload, state === 'paid' ? 'Completed' : state === 'failed' ? 'Failed' : 'Pending'),
      hubtel_message: safeProviderMessage(rawPayload) || null,
    });
    console.log('[Hubtel] Processed public payment callback:', { paymentState: state });
    res.json({ success: true, message: 'Payment updated', status: state });
  } catch {
    console.error('[Hubtel] Public payment callback processing failed.');
    res.status(500).json({ error: 'Failed to update payment' });
  }
}

export function registerHubtelWebhook(app: Express) {
  app.post('/api/hubtel/callback', handleHubtelWebhook);
  app.post('/api/hubtel/wallet-callback', handleHubtelWalletWebhook);
  console.log('[Hubtel] Webhook endpoints registered.');
}
