import { z } from "zod";
import { administratorProcedure, driverProcedure, protectedProcedure, publicProcedure, riderProcedure, router, userProcedure } from "./trpc";
import { sendVerificationEmail } from "./email";
import {
  chargeDriverCommission,
  getMomoChannel,
  getCommissionReference,
  transactionStatusCheck,
} from "./hubtel";
import { adminFirestore, ADMIN_COLLECTIONS, getAdminAuth } from "./firebaseAdmin";
import { generateReference } from "./publicPaymentsApi";
import { driverOperations, driverTrips, driverSafety, driverFinance, driverPerformance, driverScheduling, driverSupport, sendCompletedRideReceipt } from "./driverRouters";
import { getDailyPlatformFee, normalizeDriverServiceType, setDailyPlatformFee } from "./platformFee";
import { getTripChargeTotal } from "./fareAuthority";
import { hubtelPaymentState, isHubtelStatusResponseAccepted, readHubtelPaymentDetails } from './hubtelPaymentStatus';
import { isDriverFeeBypassActive } from './driverFeeBypass';
import {
  GLOBAL_DRIVER_FEE_BYPASS_DOCUMENT,
  isGlobalDriverFeeBypassActive,
  PLATFORM_SETTINGS_COLLECTION,
} from './driverFeeGlobalBypass';
import {
  buildRiderWalletTopUpPayment,
} from './riderWalletTopUp';
import { currentDriverPlatformFeeAccess } from './commissionLedger';

function hasDriverFeeTestBypass(driverId: string) {
  return String(process.env.DRIVER_FEE_TEST_BYPASS_DRIVER_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(driverId);
}

type DriverFeeCheck = {
  isPaid: boolean;
  status: 'paid' | 'expired' | 'unpaid';
  confirmedPaidAt: string | null;
  accessExpiresAt: string | null;
  remainingMs: number;
  validityLabel: string;
  feeGateDisabled?: boolean;
  testAccessGranted?: boolean;
  adminFeeBypassGranted?: boolean;
  allDriversFeeBypassGranted?: boolean;
  bypassDate?: string;
};

const DRIVER_FEE_CHECK_CACHE_MS = 14_000;
const driverFeeCheckCache = new Map<string, { value: DriverFeeCheck; expiresAt: number }>();

function feeCheckCacheExpiresAt(value: DriverFeeCheck, nowMs: number): number {
  const shortExpiry = nowMs + DRIVER_FEE_CHECK_CACHE_MS;
  const accessExpiry = value.accessExpiresAt ? Date.parse(value.accessExpiresAt) : Number.NaN;
  // A cache must never keep a paid Driver through the exact payment expiry.
  return value.isPaid && Number.isFinite(accessExpiry)
    ? Math.min(shortExpiry, accessExpiry)
    : shortExpiry;
}

async function recentDriverFeeRecords(driverId: string) {
  try {
    // A bounded, newest-first query is enough to decide the 24-hour fee gate.
    // The matching composite index avoids scanning a Driver's entire payment
    // history every time the home screen refreshes.
    return await adminFirestore.list(
      ADMIN_COLLECTIONS.DAILY_COMMISSION,
      { driver_id: driverId },
      'created_date',
      'desc',
      20,
    );
  } catch (error) {
    // Keep Driver availability working while the newly deployed index builds.
    console.warn('[DriverFee] Indexed fee lookup unavailable; using bounded compatibility scan.', error);
    return adminFirestore.list(ADMIN_COLLECTIONS.DAILY_COMMISSION, { driver_id: driverId }, null, 'desc', 100);
  }
}

async function currentDriverFeeCheck(driverId: string): Promise<DriverFeeCheck> {
  const today = new Date().toISOString().split('T')[0];
  // This lookup deliberately precedes the per-Driver cache. An administrator
  // can therefore revoke a global pass immediately, without a stale client
  // status keeping a Driver through the fee gate.
  const globalFeeBypass = await adminFirestore.get(
    PLATFORM_SETTINGS_COLLECTION,
    GLOBAL_DRIVER_FEE_BYPASS_DOCUMENT,
  );
  if (isGlobalDriverFeeBypassActive(globalFeeBypass, today)) {
    return {
      isPaid: true,
      status: 'paid',
      confirmedPaidAt: null,
      accessExpiresAt: null,
      remainingMs: 0,
      validityLabel: 'An administrator has granted a same-day operational fee pass.',
      allDriversFeeBypassGranted: true,
      bypassDate: today,
    };
  }
  const cacheKey = `${driverId}:${today}`;
  const cached = driverFeeCheckCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let value: DriverFeeCheck;
  if (process.env.DRIVER_PLATFORM_FEE_GATE_ENABLED === 'false') {
    value = {
      isPaid: true,
      status: 'paid',
      confirmedPaidAt: null,
      accessExpiresAt: null,
      remainingMs: 0,
      validityLabel: 'The Driver platform fee gate is disabled for this environment.',
      feeGateDisabled: true,
    };
  } else if (hasDriverFeeTestBypass(driverId)) {
    value = {
      isPaid: true,
      status: 'paid',
      confirmedPaidAt: null,
      accessExpiresAt: null,
      remainingMs: 0,
      validityLabel: 'Test access is enabled for this environment.',
      testAccessGranted: true,
    };
  } else {
    const driverProfile = await adminFirestore.get(ADMIN_COLLECTIONS.DRIVER_PROFILES, driverId);
    if (isDriverFeeBypassActive(driverProfile, today)) {
      value = {
        isPaid: true,
        status: 'paid',
        confirmedPaidAt: null,
        accessExpiresAt: null,
        remainingMs: 0,
        validityLabel: 'An administrator has granted a same-day operational fee pass.',
        adminFeeBypassGranted: true,
        bypassDate: today,
      };
    } else {
      const records = await recentDriverFeeRecords(driverId);
      const access = currentDriverPlatformFeeAccess(records);
      value = {
        isPaid: access.isPaid,
        status: access.status,
        confirmedPaidAt: access.confirmedPaidAt,
        accessExpiresAt: access.accessExpiresAt,
        remainingMs: access.remainingMs,
        validityLabel: access.validityLabel,
      };
    }
  }

  const nowMs = Date.now();
  driverFeeCheckCache.set(cacheKey, { value, expiresAt: feeCheckCacheExpiresAt(value, nowMs) });
  return value;
}

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
    sendReceipt: protectedProcedure
      .input(z.object({
        // Older Rider builds provide a whole receipt payload. Deliberately
        // accept only the trip ID and derive every value and recipient from
        // the completed backend ride, so this fallback cannot send a second
        // or tampered receipt.
        tripId: z.string().min(1),
      }))
      .mutation(async ({ input, ctx }) => {
        const ride = await adminFirestore.get(ADMIN_COLLECTIONS.RIDES, input.tripId);
        const riderId = String(ride?.rider_id || ride?.riderId || '');
        if (!ride || riderId !== ctx.uid) {
          throw new Error('This receipt does not belong to the signed-in Rider.');
        }
        const result = await sendCompletedRideReceipt(input.tripId);
        return {
          success: result.sent || result.alreadySent,
          alreadySent: result.alreadySent,
          pending: result.pending,
          missingRecipient: result.missingRecipient,
        };
      }),
  }),

  transactionStatus: router({
    check: protectedProcedure
      .input(z.object({
        clientReference: z.string(),
      }))
      .query(async ({ input, ctx }) => {
        const commission = (await adminFirestore.list(ADMIN_COLLECTIONS.DAILY_COMMISSION, { hubtel_reference: input.clientReference }, '', 'desc', 1))[0];
        const walletTransaction = commission ? null : (await adminFirestore.list(ADMIN_COLLECTIONS.WALLET_TRANSACTIONS, { reference: input.clientReference }, '', 'desc', 1))[0];
        const payment = commission || walletTransaction ? null : (await adminFirestore.list(ADMIN_COLLECTIONS.PAYMENTS, { reference: input.clientReference }, '', 'desc', 1))[0];
        const ownerId = String(commission?.driver_id || walletTransaction?.user_id || payment?.user_id || payment?.rider_id || '');
        if (!ownerId || ownerId !== ctx.uid) {
          throw new Error('This payment status does not belong to the signed-in account.');
        }
        const response = await transactionStatusCheck(input.clientReference);

        // Sync to Firestore if the status check succeeded
        if (response && isHubtelStatusResponseAccepted(response)) {
          const hubtelTx = readHubtelPaymentDetails(response);
          const ref = hubtelTx.clientReference || input.clientReference;
          const status = hubtelTx.status || 'Pending';
          const transactionId = hubtelTx.transactionId;
          const dbStatus = hubtelPaymentState(response);

          // 1. Try Daily Commission
          const commissionRecords = await adminFirestore.list(ADMIN_COLLECTIONS.DAILY_COMMISSION, {
            hubtel_reference: ref,
          }, "");

          if (commissionRecords && commissionRecords.length > 0) {
            const record = commissionRecords[0];
            if (dbStatus === 'paid') {
              await adminFirestore.settleDriverPlatformFee(ref, {
                transactionId,
                status,
              });
            } else if (record.status !== 'paid') {
              await adminFirestore.update(ADMIN_COLLECTIONS.DAILY_COMMISSION, record.id, {
                status: dbStatus,
                hubtel_transaction_id: transactionId || record.hubtel_transaction_id || null,
                hubtel_status: status,
              });
            }
          } else {
            // 2. Try Wallet Transaction
            const walletRecords = await adminFirestore.list(ADMIN_COLLECTIONS.WALLET_TRANSACTIONS, {
              reference: ref,
            }, "");

            if (walletRecords && walletRecords.length > 0) {
              const txRecord = walletRecords[0];

              if (dbStatus === 'paid') {
                // Hubtel can retry callbacks while the mobile app also polls.
                // Credit and mark completion together so the same payment is
                // never applied to the wallet twice.
                await adminFirestore.settleWalletTopUp(ref, {
                  transactionId,
                  status,
                });
              } else if (dbStatus === 'failed' && txRecord.status === 'processing') {
                await adminFirestore.update(ADMIN_COLLECTIONS.WALLET_TRANSACTIONS, txRecord.id, {
                  status: 'failed',
                  hubtel_status: status,
                });
              }
            } else {
              // 3. Try Generic Payment
              const paymentRecords = await adminFirestore.list(ADMIN_COLLECTIONS.PAYMENTS, { reference: ref }, "");
              if (paymentRecords && paymentRecords.length > 0) {
                await adminFirestore.update(ADMIN_COLLECTIONS.PAYMENTS, paymentRecords[0].id, {
                  status: dbStatus,
                  hubtel_transaction_id: transactionId,
                  hubtel_status: status,
                });
              }
            }
          }
        }

        return response;
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
    charge: driverProcedure(z.object({
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
        // The client-supplied date is legacy display/audit data only. A server
        // timestamp governs both the payment record and the rolling window.
        const date = new Date().toISOString().split('T')[0];
        // Read the global setting at charge time so an administrator can
        // safely change the test fee without rebuilding the Driver app.
        const driverProfile = await adminFirestore.get(ADMIN_COLLECTIONS.DRIVER_PROFILES, input.driverId);
        const serviceType = normalizeDriverServiceType(
          driverProfile?.service_type || driverProfile?.serviceType || input.serviceType,
        );
        const feeSetting = await getDailyPlatformFee(serviceType);
        const amount = feeSetting.amount;
        const channel = getMomoChannel(input.momoNetwork || 'mtn-gh');
        const clientReference = generateReference();

        const reservation = await adminFirestore.createDriverPlatformFeeCharge(input.driverId, {
          driver_name: driverProfile?.full_name || driverProfile?.name || input.driverName || 'Driver',
          date,
          amount,
          service_type: serviceType,
          momo_number: input.momoNumber,
          momo_network: input.momoNetwork || 'mtn-gh',
          hubtel_reference: clientReference,
          charge_method: 'hubtel_auto',
        });

        if (!reservation.created) {
          const existing = reservation.record;
          if (reservation.decision === 'active') {
            const access = currentDriverPlatformFeeAccess([existing]);
            return {
              success: true,
              status: 'paid' as const,
              transactionId: existing.hubtel_transaction_id || null,
              message: 'Your platform-fee payment is still valid.',
              amount: Number(existing.amount ?? amount),
              date,
              feeSource: feeSetting.source,
              clientReference: existing.hubtel_reference || null,
              commissionRecord: existing,
              confirmedPaidAt: access.confirmedPaidAt,
              accessExpiresAt: access.accessExpiresAt,
            };
          }
          return {
            success: true,
            status: 'pending' as const,
            transactionId: existing.hubtel_transaction_id || null,
            message: 'A payment request is already awaiting your MoMo approval.',
            amount: Number(existing.amount ?? amount),
            date,
            feeSource: feeSetting.source,
            clientReference: existing.hubtel_reference || null,
            commissionRecord: existing,
          };
        }

        // `chargeDriverCommission` applies one consistent Ghana MSISDN
        // normalization. Passing the original input here prevents a +233
        // value from becoming the invalid string "233+233...".
        const phone = input.momoNumber;

        const result = await chargeDriverCommission({
          customerMsisdn: phone,
          amount,
          customerName: driverProfile?.full_name || driverProfile?.name || input.driverName,
          description: `HY3N platform fee - ${date}`,
          clientReference,
          channel,
        });

        let commissionRecord = reservation.record;
        let confirmedPaidAt: string | null = null;
        let accessExpiresAt: string | null = null;
        if (result.success && result.status === 'paid') {
          const settlement = await adminFirestore.settleDriverPlatformFee(clientReference, {
            transactionId: result.transactionId,
            status: 'Completed',
            message: result.message,
          });
          commissionRecord = settlement.record || commissionRecord;
          confirmedPaidAt = commissionRecord?.confirmed_paid_at || null;
          accessExpiresAt = commissionRecord?.access_expires_at || null;
        } else if (result.success) {
          commissionRecord = await adminFirestore.update(ADMIN_COLLECTIONS.DAILY_COMMISSION, reservation.record.id, {
            status: 'processing',
            hubtel_transaction_id: result.transactionId || null,
            hubtel_status: result.status || 'Pending',
            hubtel_message: result.message || null,
          });
        } else {
          commissionRecord = await adminFirestore.update(ADMIN_COLLECTIONS.DAILY_COMMISSION, reservation.record.id, {
            status: 'failed',
            hubtel_transaction_id: result.transactionId || null,
            hubtel_status: result.status || 'Failed',
            hubtel_message: result.message || 'Hubtel did not accept the payment request.',
          });
        }

        return {
          success: result.success,
          status: result.status || 'failed',
          transactionId: result.transactionId || null,
          message: result.message || '',
          amount,
          date,
          feeSource: feeSetting.source,
          clientReference,
          commissionRecord,
          confirmedPaidAt,
          accessExpiresAt,
        };
      }),

    /** Current global fee, used by Driver screens before a payment is made. */
    getPlatformFee: publicProcedure
      .input(z.object({ serviceType: z.string().optional() }).optional())
      .query(async ({ input }) => getDailyPlatformFee(input?.serviceType)),

    /**
     * Updates the global daily driver charge. The administrator PIN is checked
     * again here rather than trusting a browser-only dashboard session.
     */
    updatePlatformFee: administratorProcedure
      .input(z.object({
        amount: z.number().min(0.01).max(1000),
        serviceType: z.string().optional(),
        adminPin: z.string().min(1),
      }))
      .mutation(async ({ input }) => {
        const fee = await setDailyPlatformFee(input.serviceType, input.amount, 'admin_dashboard');
        return { success: true, fee };
      }),

    /** Server-authoritative status for the current 24-hour fee access window. */
    getStatus: driverProcedure(z.object({
        driverId: z.string(),
        date: z.string().optional(),
      }))
      .query(async ({ input }) => {
        const date = new Date().toISOString().split('T')[0];
        const records = await recentDriverFeeRecords(input.driverId);
        const access = currentDriverPlatformFeeAccess(records);
        const clientReference = access.record?.hubtel_reference || '';
        return {
          driverId: input.driverId,
          date,
          clientReference,
          isPaid: access.isPaid,
          status: access.status,
          confirmedPaidAt: access.confirmedPaidAt,
          accessExpiresAt: access.accessExpiresAt,
          remainingMs: access.remainingMs,
          validityLabel: access.validityLabel,
        };
      }),

    /**
     * Admin: List all commissions for a date range.
     * Gated by the /api/admin/verify-pin check the admin dashboard performs
     * before it loads — not by per-request auth, since there's no user
     * session concept in this backend (see README).
     */
    listForAdmin: administratorProcedure
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
    overrideStatus: administratorProcedure
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

    checkPaidToday: driverProcedure(z.object({
        driverId: z.string(),
      }))
      .query(async ({ input }) => {
        return currentDriverFeeCheck(input.driverId);
      }),

  }),

  // ─── Rider Surge Pricing ─────────────────────────────────────────────────────
  surge: router({
    /**
     * Returns the single live surge setting. Surge is deliberately off unless
     * an administrator enables a temporary override; time of day never causes
     * a price increase by itself.
     */
    get: publicProcedure.query(async () => {
      const setting = await adminFirestore.get('platform_settings', 'surge_pricing');
      const enabled = setting?.manual_enabled === true;
      const configured = Number(setting?.manual_multiplier);
      const multiplier = enabled && Number.isFinite(configured)
        ? Math.min(2, Math.max(1, Math.round(configured * 100) / 100))
        : 1;
      return {
        active: multiplier > 1,
        multiplier,
        reason: multiplier > 1 ? 'Temporary administrator-approved high demand pricing' : null,
        updatedAt: typeof setting?.updated_at === 'string' ? setting.updated_at : null,
      };
    }),

    /** Administrator-only manual surge override, protected by the dashboard PIN. */
    update: administratorProcedure
      .input(z.object({
        enabled: z.boolean(),
        multiplier: z.number().min(1).max(2),
        adminPin: z.string().min(1),
      }))
      .mutation(async ({ input }) => {
        const updatedAt = new Date().toISOString();
        await adminFirestore.set('platform_settings', 'surge_pricing', {
          manual_enabled: input.enabled,
          manual_multiplier: input.enabled ? Math.round(input.multiplier * 100) / 100 : 1,
          updated_at: updatedAt,
          updated_by: 'admin_dashboard',
        });
        return { success: true, active: input.enabled && input.multiplier > 1, multiplier: input.enabled ? input.multiplier : 1, updatedAt };
      }),
  }),

  driverOperations,
  driverTrips,
  driverSafety,
  driverFinance,
  driverPerformance,
  driverScheduling,
  driverSupport,

  // ─── Rider / Driver Wallet ────────────────────────────────────────────────────
  wallet: router({
    /**
     * Initiate a MoMo top-up for a rider via Hubtel.
     * Sends a USSD prompt to the rider's phone.
     * The webhook at POST /api/hubtel/wallet-callback credits the wallet on success.
     */
    topup: riderProcedure(z.object({
        riderId: z.string(),
        // Retained for older Rider archives, but never trusted for a payment
        // greeting. The server resolves the registered Rider profile instead.
        riderName: z.string().optional(),
        momoNumber: z.string(),
        momoNetwork: z.string().optional(),
        amount: z.number().finite().min(5).max(5000),
      }))
      .mutation(async ({ input }) => {
        const canonicalProfile = await adminFirestore.get(ADMIN_COLLECTIONS.RIDER_PROFILES, input.riderId);
        const profileByUserId = canonicalProfile
          ? null
          : (await adminFirestore.list(
              ADMIN_COLLECTIONS.RIDER_PROFILES,
              { user_id: input.riderId },
              null,
              'desc',
              1,
            ))[0] || null;
        const payment = buildRiderWalletTopUpPayment(canonicalProfile || profileByUserId, input.amount);
        const channel = getMomoChannel(input.momoNetwork || 'mtn-gh');
        const reference = generateReference();
        const walletCallbackUrl = process.env.HUBTEL_WALLET_CALLBACK_URL || '';

        if (!walletCallbackUrl) {
          console.error('[Hubtel Wallet] HUBTEL_WALLET_CALLBACK_URL is not configured.');
          return { success: false, message: 'Wallet top-up is temporarily unavailable. Please try again later.' };
        }

        // Create a pending wallet transaction record first (for idempotency)
        const txRecord = await adminFirestore.create(ADMIN_COLLECTIONS.WALLET_TRANSACTIONS, {
          user_id: input.riderId,
          user_type: 'rider',
          type: 'credit',
          amount: payment.amount,
          description: payment.description,
          payment_purpose: payment.paymentPurpose,
          payer_display_name: payment.customerName,
          provider_requested_amount: payment.amount,
          reference,
          status: 'processing',
          callback_url: walletCallbackUrl,
          date: new Date().toISOString(),
        });

        const result = await chargeDriverCommission({
          // chargeDriverCommission normalizes Ghana's local, 233, and +233
          // formats once. Passing the original entry prevents "233+233...".
          customerMsisdn: input.momoNumber,
          amount: payment.amount,
          customerName: payment.customerName,
          description: payment.description,
          clientReference: reference,
          channel,
          callbackUrl: walletCallbackUrl,
        });

        if (!result.success) {
          await adminFirestore.update(ADMIN_COLLECTIONS.WALLET_TRANSACTIONS, txRecord.id, {
            status: 'failed',
            hubtel_message: result.message,
          });
          return { success: false, message: result.message || 'Top-up failed', reference, txId: txRecord.id };
        }

        if (result.status === 'paid') {
          await adminFirestore.settleWalletTopUp(reference, {
            transactionId: result.transactionId,
            status: 'Completed',
            message: result.message,
          });
        } else {
          await adminFirestore.update(ADMIN_COLLECTIONS.WALLET_TRANSACTIONS, txRecord.id, {
            status: 'processing',
            hubtel_transaction_id: result.transactionId || null,
            hubtel_status: result.status || 'Pending',
            hubtel_message: result.message || null,
          });
        }

        return {
          success: true,
          status: result.status === 'paid' ? 'completed' : 'processing',
          message: 'USSD prompt sent. Please approve on your phone.',
          reference,
          txId: txRecord.id,
          transactionId: result.transactionId,
        };
      }),

    /**
     * Get a user's wallet balance.
     */
    getBalance: userProcedure(z.object({ userId: z.string() }))
      .query(async ({ input }) => {
        const wallet = await adminFirestore.get(ADMIN_COLLECTIONS.WALLET, input.userId);
        return { balance: wallet?.balance ?? 0, currency: 'GHS' };
      }),

    /**
     * Get wallet transaction history for a user.
     */
    getTransactions: userProcedure(z.object({
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
    settleRide: riderProcedure(z.object({
        rideId: z.string(),
        riderId: z.string(),
      }))
      .mutation(async ({ input }) => {
        const ride = await adminFirestore.get(ADMIN_COLLECTIONS.RIDES, input.rideId);
        if (!ride || ride.status !== 'completed') {
          return { success: false, message: 'This ride has not been completed yet.' };
        }
        const rideRiderId = String(ride.rider_id || ride.riderId || ride.rider?.id || '');
        const rideDriverId = String(ride.driver_id || ride.driverId || ride.driver?.id || '');
        if (rideRiderId !== input.riderId || !rideDriverId) {
          return { success: false, message: 'Ride payment details do not match this trip.' };
        }
        if (ride.wallet_settled_at) {
          const existingWallet = (await getOrCreateWallet(input.riderId, 'rider')) as any;
          return { success: true, alreadySettled: true, newRiderBalance: Number(existingWallet.balance || 0) };
        }

        // Never charge an amount supplied by a mobile client. The completed
        // ride record contains the single quote-backed amount both apps show.
        const fare = getTripChargeTotal(ride);
        const riderWallet = (await getOrCreateWallet(input.riderId, 'rider')) as any;
        const currentBalance = (riderWallet.balance as number) ?? 0;

        if (currentBalance < fare) {
          return { success: false, message: `Insufficient wallet balance. Balance: GH₵${currentBalance.toFixed(2)}, Fare: GH₵${fare.toFixed(2)}` };
        }

        const reference = `hy3n-ride-${input.rideId}`;
        const now = new Date().toISOString();

        // Deduct from rider wallet
        await adminFirestore.set(ADMIN_COLLECTIONS.WALLET, input.riderId, {
          balance: currentBalance - fare,
          total_spent: ((riderWallet.total_spent as number) ?? 0) + fare,
        });
        await recordWalletTransaction(
          input.riderId, 'debit', fare,
          `Ride to ${typeof ride.destination === 'string' ? ride.destination : ride.destination?.name || 'destination'}`,
          reference,
          { ride_id: input.rideId, driver_id: rideDriverId, date: now },
        );

        // Credit driver wallet
        const driverWallet = (await getOrCreateWallet(rideDriverId, 'driver')) as any;
        await adminFirestore.set(ADMIN_COLLECTIONS.WALLET, rideDriverId, {
          balance: ((driverWallet.balance as number) ?? 0) + fare,
          total_earned: ((driverWallet.total_earned as number) ?? 0) + fare,
        });
        await recordWalletTransaction(
          rideDriverId, 'credit', fare,
          `Ride fare from ${typeof ride.pickup === 'string' ? ride.pickup : ride.pickup?.name || 'pickup'}`,
          reference,
          { ride_id: input.rideId, rider_id: input.riderId, date: now },
        );

        await adminFirestore.update(ADMIN_COLLECTIONS.RIDES, input.rideId, {
          wallet_settled_at: now,
          wallet_settled_fare: fare,
          wallet_settlement_reference: reference,
        });

        return { success: true, newRiderBalance: currentBalance - fare, fare };
      }),
  }),
});

export type AppRouter = typeof appRouter;
