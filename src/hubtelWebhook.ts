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
import { adminFirestore, ADMIN_COLLECTIONS as COLLECTIONS } from './firebaseAdmin';

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
export async function handleHubtelWebhook(req: Request, res: Response) {
  const rawPayload = req.body || {};
  const dataPayload = rawPayload.Data || {};

  const clientReference = dataPayload.ClientReference || rawPayload.ClientReference || "";
  const transactionId = dataPayload.TransactionId || rawPayload.TransactionId || "";
  const status = dataPayload.Status || rawPayload.Status || "";
  const message = dataPayload.Description || rawPayload.Message || "";
  const responseCode = rawPayload.ResponseCode || dataPayload.ResponseCode || "";

  console.log('[Hubtel Webhook] Headers:', req.headers);
  console.log('[Hubtel Webhook] Body:', req.body);

  console.log('[Hubtel Webhook] Parsed:', {
    transactionId,
    status,
    clientReference,
    responseCode,
  });

  if (!clientReference) {
    console.warn('[Hubtel Webhook] Missing ClientReference');
    res.status(400).json({ error: 'Missing ClientReference' });
    return;
  }

  try {
    // 1. Try to find a Daily Commission record
    const commissionRecords = await adminFirestore.list(COLLECTIONS.DAILY_COMMISSION, {
      hubtel_reference: clientReference,
    }, "");

    if (commissionRecords && commissionRecords.length > 0) {
      const record = commissionRecords[0];
      const driverId = record.driver_id;
      const date = record.date;

      let newStatus: 'paid' | 'failed' | 'processing' = 'processing';
      if (responseCode === '0000' || status === 'Success' || rawPayload.Message === 'success') {
        newStatus = 'paid';
      } else if (responseCode !== '0000' && responseCode !== '0001' && responseCode !== '' || status === 'Failed' || rawPayload.Message === 'failed') {
        newStatus = 'failed';
      }

      await adminFirestore.update(COLLECTIONS.DAILY_COMMISSION, record.id, {
        status: newStatus,
        hubtel_webhook_received_at: new Date().toISOString(),
        hubtel_transaction_id: transactionId || record.hubtel_transaction_id,
        hubtel_status: status || rawPayload.Message || (newStatus === 'paid' ? 'Success' : 'Failed'),
        hubtel_message: message,
      });

      console.log('[Hubtel Webhook] Updated commission:', {
        driverId,
        date,
        newStatus,
        transactionId,
      });

      res.json({
        success: true,
        message: 'Commission updated',
        status: newStatus,
      });
      return;
    }

    // 2. Try to find a Wallet Top-up record
    const walletRecords = await adminFirestore.list(COLLECTIONS.WALLET_TRANSACTIONS, {
      reference: clientReference,
    }, "");

    if (walletRecords && walletRecords.length > 0) {
      const txRecord = walletRecords[0];
      const userId = txRecord.user_id;
      const amount = txRecord.amount as number;

      let isSuccess = false;
      let isFailed = false;
      if (responseCode === '0000' || status === 'Success' || rawPayload.Message === 'success') {
        isSuccess = true;
      } else if (responseCode !== '0000' && responseCode !== '0001' && responseCode !== '' || status === 'Failed' || rawPayload.Message === 'failed') {
        isFailed = true;
      }

      if (isSuccess) {
        const walletSnap = await adminFirestore.get(COLLECTIONS.WALLET, userId);
        const currentBalance = (walletSnap?.balance as number) ?? 0;
        const totalToppedUp = (walletSnap?.total_topped_up as number) ?? 0;

        await adminFirestore.set(COLLECTIONS.WALLET, userId, {
          user_id: userId,
          user_type: txRecord.user_type || 'rider',
          balance: currentBalance + amount,
          total_topped_up: totalToppedUp + amount,
        });

        await adminFirestore.update(COLLECTIONS.WALLET_TRANSACTIONS, txRecord.id, {
          status: 'completed',
          hubtel_transaction_id: transactionId,
          hubtel_status: status || 'Success',
          completed_at: new Date().toISOString(),
        });

        console.log('[Hubtel Wallet Webhook] Wallet credited:', { userId, amount, newBalance: currentBalance + amount });
        res.json({ success: true, message: 'Wallet credited', newBalance: currentBalance + amount });
      } else if (isFailed) {
        await adminFirestore.update(COLLECTIONS.WALLET_TRANSACTIONS, txRecord.id, {
          status: 'failed',
          hubtel_status: status || 'Failed',
          hubtel_message: message,
        });
        res.json({ success: false, message: 'Payment failed' });
      } else {
        res.json({ success: true, message: 'Pending — no action taken' });
      }
      return;
    }

    // 3. Fall back to generic payment
    await handleGenericPaymentWebhook({
      ClientReference: clientReference,
      TransactionId: transactionId,
      Status: status,
      Message: message,
    }, res);

  } catch (err: any) {
    console.error('[Hubtel Webhook] Error processing callback:', err?.message);
    res.status(500).json({
      error: 'Failed to process callback',
      message: err?.message,
    });
  }
}

/**
 * Handle Hubtel wallet top-up webhook callback.
 * Credits the rider/driver wallet when Hubtel confirms payment.
 */
export async function handleHubtelWalletWebhook(req: Request, res: Response) {
  const rawPayload = req.body || {};
  const dataPayload = rawPayload.Data || {};

  const clientReference = dataPayload.ClientReference || rawPayload.ClientReference || "";
  const transactionId = dataPayload.TransactionId || rawPayload.TransactionId || "";
  const status = dataPayload.Status || rawPayload.Status || "";
  const message = dataPayload.Description || rawPayload.Message || "";
  const responseCode = rawPayload.ResponseCode || dataPayload.ResponseCode || "";

  console.log('[Hubtel Wallet Webhook] Received:', {
    transactionId,
    status,
    clientReference,
  });

  if (!clientReference) {
    res.status(400).json({ error: 'Missing ClientReference' });
    return;
  }

  try {
    const records = await adminFirestore.list(COLLECTIONS.WALLET_TRANSACTIONS, {
      reference: clientReference,
    }, "");

    if (!records || records.length === 0) {
      res.status(404).json({ error: 'Wallet transaction record not found' });
      return;
    }

    const txRecord = records[0];
    const userId = txRecord.user_id;
    const amount = txRecord.amount as number;

    let isSuccess = false;
    let isFailed = false;
    if (responseCode === '0000' || status === 'Success' || rawPayload.Message === 'success') {
      isSuccess = true;
    } else if (responseCode !== '0000' && responseCode !== '0001' && responseCode !== '' || status === 'Failed' || rawPayload.Message === 'failed') {
      isFailed = true;
    }

    if (isSuccess) {
      const walletSnap = await adminFirestore.get(COLLECTIONS.WALLET, userId);
      const currentBalance = (walletSnap?.balance as number) ?? 0;
      const totalToppedUp = (walletSnap?.total_topped_up as number) ?? 0;

      await adminFirestore.set(COLLECTIONS.WALLET, userId, {
        user_id: userId,
        user_type: txRecord.user_type || 'rider',
        balance: currentBalance + amount,
        total_topped_up: totalToppedUp + amount,
      });

      await adminFirestore.update(COLLECTIONS.WALLET_TRANSACTIONS, txRecord.id, {
        status: 'completed',
        hubtel_transaction_id: transactionId,
        hubtel_status: status || 'Success',
        completed_at: new Date().toISOString(),
      });

      console.log('[Hubtel Wallet Webhook] Wallet credited:', { userId, amount, newBalance: currentBalance + amount });
      res.json({ success: true, message: 'Wallet credited', newBalance: currentBalance + amount });
    } else if (isFailed) {
      await adminFirestore.update(COLLECTIONS.WALLET_TRANSACTIONS, txRecord.id, {
        status: 'failed',
        hubtel_status: status || 'Failed',
        hubtel_message: message,
      });
      res.json({ success: false, message: 'Payment failed' });
    } else {
      res.json({ success: true, message: 'Pending — no action taken' });
    }
  } catch (err: any) {
    console.error('[Hubtel Wallet Webhook] Error:', err?.message);
    res.status(500).json({ error: 'Failed to process wallet top-up', message: err?.message });
  }
}

/**
 * Handle webhook callbacks for charges initiated via the public payments API
 * (src/publicPaymentsApi.ts), keyed by the `reference` field on the generic
 * `payments` Firestore collection.
 */
async function handleGenericPaymentWebhook(payload: HubtelWebhookPayload, res: Response) {
  const clientReference = payload.ClientReference!;

  try {
    const matches = await adminFirestore.list(COLLECTIONS.PAYMENTS, { reference: clientReference }, "");
    const record = matches[0];
    if (!record) {
      console.warn('[Hubtel Webhook] No payment record found for ClientReference:', clientReference);
      res.status(404).json({ error: 'Unknown ClientReference' });
      return;
    }

    let newStatus: 'paid' | 'failed' | 'processing' = 'processing';
    if (payload.Status === 'Success') {
      newStatus = 'paid';
    } else if (payload.Status === 'Failed') {
      newStatus = 'failed';
    }

    await adminFirestore.update(COLLECTIONS.PAYMENTS, record.id, {
      status: newStatus,
      hubtel_webhook_received_at: new Date().toISOString(),
      hubtel_transaction_id: payload.TransactionId || record.hubtel_transaction_id,
      hubtel_status: payload.Status,
      hubtel_message: payload.Message,
    });

    console.log('[Hubtel Webhook] Updated public payment:', {
      clientReference,
      newStatus,
      transactionId: payload.TransactionId,
    });

    res.json({ success: true, message: 'Payment updated', status: newStatus });
  } catch (err: any) {
    console.error('[Hubtel Webhook] Error updating public payment:', err?.message);
    res.status(500).json({ error: 'Failed to update payment', message: err?.message });
  }
}

/**
 * Register the Hubtel webhook endpoints.
 */
export function registerHubtelWebhook(app: Express) {
  app.post('/api/hubtel/callback', handleHubtelWebhook);
  app.post('/api/hubtel/wallet-callback', handleHubtelWalletWebhook);
  console.log('[Hubtel] Webhook endpoints registered at POST /api/hubtel/callback and /api/hubtel/wallet-callback');
}
