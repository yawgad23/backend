import type { Express, Request, Response } from "express";
import { adminFirestore, ADMIN_COLLECTIONS } from "./firebaseAdmin";
import { transactionStatusCheck } from "./hubtel";

export function registerCronRoutes(app: Express) {
  /**
   * POST /api/cron/check-pending
   * Iterates through pending/processing payments.
   * - If pending > 48 hours: immediately transitions status to "failed".
   * - If pending <= 48 hours: queries Hubtel for transaction status to sync.
   *
   * Query Param: ?secret=ADMIN_DASHBOARD_PIN
   */
  app.post("/api/cron/check-pending", async (req: Request, res: Response) => {
    const cronKey = req.query.secret || req.headers['x-cron-key'];
    const adminPin = process.env.ADMIN_DASHBOARD_PIN;

    if (!adminPin) {
      console.error("[Cron] ADMIN_DASHBOARD_PIN is not configured.");
      res.status(500).json({ success: false, error: "Cron dashboard pin not configured" });
      return;
    }

    if (cronKey !== adminPin) {
      res.status(401).json({ success: false, error: "Unauthorized" });
      return;
    }

    console.log("[Cron] Running check-pending status checks...");
    const stats = {
      commissionsChecked: 0,
      commissionsFailed: 0,
      commissionsUpdated: 0,
      walletsChecked: 0,
      walletsFailed: 0,
      walletsUpdated: 0,
      paymentsChecked: 0,
      paymentsFailed: 0,
      paymentsUpdated: 0,
      ridesChecked: 0,
      ridesCancelled: 0,
    };

    try {
      // ─── 1. Daily Commission Status Checks ─────────────────────────────────
      const pendingCommissions = await adminFirestore.list(
        ADMIN_COLLECTIONS.DAILY_COMMISSION,
        { status: "processing" },
        null
      );

      for (const record of pendingCommissions) {
        const submittedAt = record.submitted_at || record.created_date || record.date;
        if (!submittedAt) continue;

        const ageMs = Date.now() - new Date(submittedAt).getTime();
        const ageHours = ageMs / (1000 * 60 * 60);

        if (ageHours > 48) {
          await adminFirestore.update(ADMIN_COLLECTIONS.DAILY_COMMISSION, record.id, {
            status: "failed",
            hubtel_status: "Expired",
            hubtel_message: "Auto-expired: pending longer than 48 hours",
          });
          stats.commissionsFailed++;
        } else {
          const ref = record.hubtel_reference || record.clientReference;
          if (ref) {
            stats.commissionsChecked++;
            try {
              const response = await transactionStatusCheck(ref);
              if (response && response.responseCode === "0000" && response.data) {
                const status = response.data.status;
                const transactionId = response.data.transactionId;
                if (status === 'Paid') {
                  await adminFirestore.update(ADMIN_COLLECTIONS.DAILY_COMMISSION, record.id, {
                    status: 'paid',
                    hubtel_transaction_id: transactionId,
                    hubtel_status: status,
                  });
                  stats.commissionsUpdated++;
                } else if (status === 'Failed' || status === 'Expired' || status === 'Cancelled' || status === 'Declined') {
                  await adminFirestore.update(ADMIN_COLLECTIONS.DAILY_COMMISSION, record.id, {
                    status: 'failed',
                    hubtel_transaction_id: transactionId,
                    hubtel_status: status,
                  });
                  stats.commissionsFailed++;
                }
              }
            } catch (err: any) {
              console.error(`[Cron] Error checking status for commission ${record.id}:`, err.message);
            }
          }
        }
      }

      // ─── 2. Wallet Transactions Status Checks ──────────────────────────────
      const pendingWallets = await adminFirestore.list(
        ADMIN_COLLECTIONS.WALLET_TRANSACTIONS,
        { status: "processing" },
        null
      );

      for (const record of pendingWallets) {
        const date = record.date;
        if (!date) continue;

        const ageMs = Date.now() - new Date(date).getTime();
        const ageHours = ageMs / (1000 * 60 * 60);

        if (ageHours > 48) {
          await adminFirestore.update(ADMIN_COLLECTIONS.WALLET_TRANSACTIONS, record.id, {
            status: "failed",
            hubtel_status: "Expired",
          });
          stats.walletsFailed++;
        } else {
          const ref = record.reference;
          if (ref) {
            stats.walletsChecked++;
            try {
              const response = await transactionStatusCheck(ref);
              if (response && response.responseCode === "0000" && response.data) {
                const status = response.data.status;
                const transactionId = response.data.transactionId;
                if (status === 'Paid') {
                  const userId = record.user_id;
                  const walletSnap = await adminFirestore.get(ADMIN_COLLECTIONS.WALLET, userId);
                  const currentBalance = (walletSnap?.balance as number) ?? 0;
                  const totalToppedUp = (walletSnap?.total_topped_up as number) ?? 0;
                  const amount = record.amount as number;

                  await adminFirestore.set(ADMIN_COLLECTIONS.WALLET, userId, {
                    user_id: userId,
                    user_type: record.user_type || 'rider',
                    balance: currentBalance + amount,
                    total_topped_up: totalToppedUp + amount,
                  });

                  await adminFirestore.update(ADMIN_COLLECTIONS.WALLET_TRANSACTIONS, record.id, {
                    status: 'completed',
                    hubtel_transaction_id: transactionId,
                    hubtel_status: status,
                    completed_at: new Date().toISOString(),
                  });
                  stats.walletsUpdated++;
                } else if (status === 'Failed' || status === 'Expired' || status === 'Cancelled' || status === 'Declined') {
                  await adminFirestore.update(ADMIN_COLLECTIONS.WALLET_TRANSACTIONS, record.id, {
                    status: 'failed',
                    hubtel_status: status,
                  });
                  stats.walletsFailed++;
                }
              }
            } catch (err: any) {
              console.error(`[Cron] Error checking status for wallet txn ${record.id}:`, err.message);
            }
          }
        }
      }

      // ─── 3. Generic Payments Status Checks ──────────────────────────────────
      const pendingPayments = await adminFirestore.list(
        ADMIN_COLLECTIONS.PAYMENTS,
        { status: "pending" },
        null
      );

      for (const record of pendingPayments) {
        const createdDate = record.created_date || record.date;
        if (!createdDate) continue;

        const ageMs = Date.now() - new Date(createdDate).getTime();
        const ageHours = ageMs / (1000 * 60 * 60);

        if (ageHours > 48) {
          await adminFirestore.update(ADMIN_COLLECTIONS.PAYMENTS, record.id, {
            status: "failed",
            hubtel_message: "Auto-expired: pending longer than 48 hours",
          });
          stats.paymentsFailed++;
        } else {
          const ref = record.reference;
          if (ref) {
            stats.paymentsChecked++;
            try {
              const response = await transactionStatusCheck(ref);
              if (response && response.responseCode === "0000" && response.data) {
                const status = response.data.status;
                const transactionId = response.data.transactionId;
                if (status === 'Paid') {
                  await adminFirestore.update(ADMIN_COLLECTIONS.PAYMENTS, record.id, {
                    status: 'paid',
                    hubtel_transaction_id: transactionId,
                    hubtel_message: 'Success',
                  });
                  stats.paymentsUpdated++;
                } else if (status === 'Failed' || status === 'Expired' || status === 'Cancelled' || status === 'Declined') {
                  await adminFirestore.update(ADMIN_COLLECTIONS.PAYMENTS, record.id, {
                    status: 'failed',
                    hubtel_transaction_id: transactionId,
                    hubtel_message: status,
                  });
                  stats.paymentsFailed++;
                }
              }
            } catch (err: any) {
              console.error(`[Cron] Error checking status for payment ${record.id}:`, err.message);
            }
          }
        }
      }

      // ─── 4. Stale Rides Checks ─────────────────────────────────────────────
      const requestedRides = await adminFirestore.list(
        ADMIN_COLLECTIONS.RIDES,
        { status: "requested" },
        null
      );

      for (const ride of requestedRides) {
        const createdDate = ride.created_date || ride.date;
        if (!createdDate) continue;

        stats.ridesChecked++;
        const ageMs = Date.now() - new Date(createdDate).getTime();
        const ageHours = ageMs / (1000 * 60 * 60);

        // Auto-cancel if waiting for a driver for more than 2 hours
        if (ageHours >= 2) {
          await adminFirestore.update(ADMIN_COLLECTIONS.RIDES, ride.id, {
            status: "cancelled",
            cancellation_reason: "Auto-cancelled: No driver accepted within 2 hours",
            updated_date: new Date().toISOString()
          });
          stats.ridesCancelled++;
        }
      }

      console.log("[Cron] Completed check-pending status checks. Stats:", stats);
      res.json({ success: true, stats });
    } catch (err: any) {
      console.error("[Cron] Failed to run check-pending:", err.message);
      res.status(500).json({ success: false, error: "Internal Server Error", message: err.message });
    }
  });
}
