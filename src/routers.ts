import { z } from "zod";
import { publicProcedure, router } from "./trpc";
import { sendTripReceiptEmail } from "./email";
import {
  chargeDriverCommission,
  getCommissionAmount,
  getMomoChannel,
  getCommissionReference,
} from "./hubtel";
import { adminFirestore, ADMIN_COLLECTIONS } from "./firebaseAdmin";

// ─── Wallet helpers ─────────────────────────────────────────────────────────

async function getOrCreateWallet(userId: string, userType: 'rider' | 'driver' = 'rider') {
  const existing = await adminFirestore.get(ADMIN_COLLECTIONS.WALLET, userId);
  if (existing) return existing;
  return adminFirestore.set(ADMIN_COLLECTIONS.WALLET, userId, {
    user_id: userId,
    user_type: userType,
    balance: 0,
    total_topped_up: 0,
    total_spent: 0,
    total_earned: 0,
    created_date: new Date().toISOString(),
  });
}

async function recordWalletTransaction(
  userId: string,
  type: 'credit' | 'debit' | 'refund',
  amount: number,
  description: string,
  reference: string,
  meta: Record<string, any> = {},
) {
  return adminFirestore.create(ADMIN_COLLECTIONS.WALLET_TRANSACTIONS, {
    user_id: userId,
    type,
    amount,
    description,
    reference,
    date: new Date().toISOString(),
    ...meta,
  });
}

export const appRouter = router({
  // ─── Trip Receipt Email ───────────────────────────────────────────────────────
  trips: router({
    sendReceipt: publicProcedure
      .input(z.object({
        riderEmail: z.string().email(),
        riderName: z.string(),
        driverName: z.string(),
        driverVehicle: z.string(),
        driverPlate: z.string(),
        pickup: z.string(),
        destination: z.string(),
        fare: z.number(),
        paymentMethod: z.string(),
        distance: z.number().optional(),
        duration: z.number().optional(),
        category: z.string().optional(),
        tripId: z.string(),
        completedAt: z.string(),
      }))
      .mutation(async ({ input }) => {
        const sent = await sendTripReceiptEmail(input);
        return { success: sent };
      }),
  }),

  // ─── Hubtel Daily Commission ──────────────────────────────────────────────────
  commission: router({
    /**
     * Charge a driver's daily commission via Hubtel Direct Receive Money.
     * The driver receives a USSD prompt on their phone to approve the payment.
     *
     * Returns:
     *   - success: true if Hubtel accepted the charge request
     *   - status: "pending" (USSD sent, awaiting driver approval) | "failed"
     *   - transactionId: Hubtel's transaction reference
     *   - message: human-readable status message
     */
    charge: publicProcedure
      .input(z.object({
        /** Driver's Firestore user_id (used for idempotency reference) */
        driverId: z.string(),
        /** Driver's full name */
        driverName: z.string(),
        /** Driver's MoMo phone number (e.g. "0244123456") */
        momoNumber: z.string(),
        /** MoMo network: "mtn-gh" | "vodafone-gh" | "tigo-gh" */
        momoNetwork: z.string().optional(),
        /** Driver service type: "car" | "okada" | "delivery" */
        serviceType: z.string(),
        /** ISO date string YYYY-MM-DD (defaults to today) */
        date: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        const date = input.date || new Date().toISOString().split('T')[0];
        const amount = getCommissionAmount(input.serviceType);
        const channel = getMomoChannel(input.momoNetwork || 'mtn-gh');
        const clientReference = getCommissionReference(input.driverId, date);

        // Format phone number: ensure it starts with country code
        let phone = input.momoNumber.replace(/\s+/g, '').replace(/^0/, '233');
        if (!phone.startsWith('233')) phone = '233' + phone;

        const result = await chargeDriverCommission({
          customerMsisdn: phone,
          amount,
          customerName: input.driverName,
          description: `HY3N daily platform fee - ${date}`,
          clientReference,
          channel,
        });

        return {
          success: result.success,
          status: result.status || 'failed',
          transactionId: result.transactionId || null,
          message: result.message || '',
          amount,
          date,
          clientReference,
        };
      }),

    /**
     * Get the commission status for a driver on a given date.
     * Used by the driver app to check if today's fee has been paid.
     *
     * Note: The Firestore record is the source of truth for the app UI —
     * the driver app writes/reads directly from Firestore. This endpoint
     * just returns the reference so the client can look it up.
     */
    getStatus: publicProcedure
      .input(z.object({
        driverId: z.string(),
        date: z.string().optional(),
      }))
      .query(async ({ input }) => {
        const date = input.date || new Date().toISOString().split('T')[0];
        const clientReference = getCommissionReference(input.driverId, date);
        return {
          driverId: input.driverId,
          date,
          clientReference,
        };
      }),

    /**
     * Admin: List all commissions for a date range.
     * Gated by the /api/admin/verify-pin check the admin dashboard performs
     * before it loads — not by per-request auth, since there's no user
     * session concept in this backend (see README).
     */
    listForAdmin: publicProcedure
      .input(z.object({
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
        status: z.string().optional(),
      }))
      .query(async ({ input }) => {
        const allCommissions = await adminFirestore.list(
          ADMIN_COLLECTIONS.DAILY_COMMISSION,
          {},
          'created_date',
          'desc',
          500,
        );

        let filtered = allCommissions;

        if (input.dateFrom) {
          filtered = filtered.filter((c: any) => c.date >= input.dateFrom!);
        }
        if (input.dateTo) {
          filtered = filtered.filter((c: any) => c.date <= input.dateTo!);
        }
        if (input.status) {
          filtered = filtered.filter((c: any) => c.status === input.status);
        }

        // Enrich with driver profile info where available
        const enriched = await Promise.all(
          filtered.map(async (commission: any) => {
            let driverName = commission.driver_name || 'Unknown Driver';
            let serviceType = commission.service_type || 'car';
            if (commission.driver_id && !commission.driver_name) {
              try {
                const profile = await adminFirestore.get(
                  ADMIN_COLLECTIONS.DRIVER_PROFILES,
                  commission.driver_id,
                );
                if (profile) {
                  driverName = profile.full_name || profile.name || driverName;
                  serviceType = profile.service_type || serviceType;
                }
              } catch {
                // Ignore enrichment errors
              }
            }
            return { ...commission, driver_name: driverName, service_type: serviceType };
          })
        );

        return { commissions: enriched };
      }),

    /**
     * Admin: Override a commission status manually.
     * Same PIN-gated access model as listForAdmin above.
     */
    overrideStatus: publicProcedure
      .input(z.object({
        commissionId: z.string(),
        newStatus: z.enum(['paid', 'failed', 'processing']),
        reason: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        const updated = await adminFirestore.update(
          ADMIN_COLLECTIONS.DAILY_COMMISSION,
          input.commissionId,
          {
            status: input.newStatus,
            admin_override: true,
            admin_override_reason: input.reason || 'Manual admin override',
            admin_override_by: 'admin',
            admin_override_at: new Date().toISOString(),
          },
        );
        return { success: true, commission: updated };
      }),
  }),

  
  // ─── Rider / Driver Wallet ────────────────────────────────────────────────────
  wallet: router({
    /**
     * Initiate a MoMo top-up for a rider via Hubtel.
     * Sends a USSD prompt to the rider's phone.
     * The webhook at POST /api/hubtel/wallet-callback credits the wallet on success.
     */
    topup: publicProcedure
      .input(z.object({
        riderId: z.string(),
        riderName: z.string(),
        momoNumber: z.string(),
        momoNetwork: z.string().optional(),
        amount: z.number().min(5).max(5000),
      }))
      .mutation(async ({ input }) => {
        const channel = getMomoChannel(input.momoNetwork || 'mtn-gh');
        const reference = `hy3n-topup-${input.riderId}-${Date.now()}`;
        let phone = input.momoNumber.replace(/\s+/g, '').replace(/^0/, '233');
        if (!phone.startsWith('233')) phone = '233' + phone;

        // Create a pending wallet transaction record first (for idempotency)
        const txRecord = await adminFirestore.create(ADMIN_COLLECTIONS.WALLET_TRANSACTIONS, {
          user_id: input.riderId,
          user_type: 'rider',
          type: 'credit',
          amount: input.amount,
          description: `Wallet top-up via MoMo`,
          reference,
          status: 'processing',
          date: new Date().toISOString(),
        });

        const result = await chargeDriverCommission({
          customerMsisdn: phone,
          amount: input.amount,
          customerName: input.riderName,
          description: `HY3N wallet top-up GH₵${input.amount}`,
          clientReference: reference,
          channel,
        });

        if (!result.success) {
          await adminFirestore.update(ADMIN_COLLECTIONS.WALLET_TRANSACTIONS, txRecord.id, {
            status: 'failed',
            hubtel_message: result.message,
          });
          return { success: false, message: result.message || 'Top-up failed', reference, txId: txRecord.id };
        }

        return {
          success: true,
          status: 'processing',
          message: 'USSD prompt sent. Please approve on your phone.',
          reference,
          txId: txRecord.id,
          transactionId: result.transactionId,
        };
      }),

    /**
     * Get a user's wallet balance.
     */
    getBalance: publicProcedure
      .input(z.object({ userId: z.string() }))
      .query(async ({ input }) => {
        const wallet = await adminFirestore.get(ADMIN_COLLECTIONS.WALLET, input.userId);
        return { balance: wallet?.balance ?? 0, currency: 'GHS' };
      }),

    /**
     * Get wallet transaction history for a user.
     */
    getTransactions: publicProcedure
      .input(z.object({
        userId: z.string(),
        limit: z.number().optional(),
      }))
      .query(async ({ input }) => {
        const txns = await adminFirestore.list(
          ADMIN_COLLECTIONS.WALLET_TRANSACTIONS,
          { user_id: input.userId },
          'date',
          'desc',
          input.limit ?? 30,
        );
        return { transactions: txns };
      }),

    /**
     * Settle a completed ride: deduct fare from rider wallet, credit driver wallet.
     * Called server-side when ride status changes to 'completed' with payment='wallet'.
     */
    settleRide: publicProcedure
      .input(z.object({
        rideId: z.string(),
        riderId: z.string(),
        driverId: z.string(),
        driverName: z.string(),
        riderName: z.string(),
        fare: z.number(),
        pickup: z.string(),
        destination: z.string(),
      }))
      .mutation(async ({ input }) => {
        const riderWallet = (await getOrCreateWallet(input.riderId, 'rider')) as any;
        const currentBalance = (riderWallet.balance as number) ?? 0;

        if (currentBalance < input.fare) {
          return { success: false, message: `Insufficient wallet balance. Balance: GH₵${currentBalance.toFixed(2)}, Fare: GH₵${input.fare.toFixed(2)}` };
        }

        const reference = `hy3n-ride-${input.rideId}`;
        const now = new Date().toISOString();

        // Deduct from rider wallet
        await adminFirestore.set(ADMIN_COLLECTIONS.WALLET, input.riderId, {
          balance: currentBalance - input.fare,
          total_spent: ((riderWallet.total_spent as number) ?? 0) + input.fare,
        });
        await recordWalletTransaction(
          input.riderId, 'debit', input.fare,
          `Ride to ${input.destination}`,
          reference,
          { ride_id: input.rideId, driver_id: input.driverId, date: now },
        );

        // Credit driver wallet
        const driverWallet = (await getOrCreateWallet(input.driverId, 'driver')) as any;
        await adminFirestore.set(ADMIN_COLLECTIONS.WALLET, input.driverId, {
          balance: ((driverWallet.balance as number) ?? 0) + input.fare,
          total_earned: ((driverWallet.total_earned as number) ?? 0) + input.fare,
        });
        await recordWalletTransaction(
          input.driverId, 'credit', input.fare,
          `Ride fare from ${input.pickup}`,
          reference,
          { ride_id: input.rideId, rider_id: input.riderId, date: now },
        );

        return { success: true, newRiderBalance: currentBalance - input.fare };
      }),
  }),
});

export type AppRouter = typeof appRouter;
