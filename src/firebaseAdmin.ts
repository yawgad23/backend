/**
 * Firebase Admin SDK — server-side only.
 *
 * Initialisation: the service account is read from the FIREBASE_SERVICE_ACCOUNT
 * environment variable (JSON string). If not set, falls back to Application
 * Default Credentials (works on Cloud Run automatically when the runtime
 * service account has Firestore access).
 */

import { initializeApp, getApps, cert, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

// ─── App singleton ────────────────────────────────────────────────────────────

export function getAdminAuth() {
  return getAuth(getAdminApp());
}

let _app: App | null = null;

function getAdminApp(): App {
  if (_app) return _app;
  const existing = getApps();
  if (existing.length > 0) {
    _app = existing[0];
    return _app;
  }

  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (serviceAccountJson) {
    try {
      const serviceAccount = JSON.parse(serviceAccountJson);
      _app = initializeApp({
        credential: cert(serviceAccount),
        projectId: serviceAccount.project_id,
      });
    } catch (err) {
      console.error('[Firebase Admin] Failed to parse FIREBASE_SERVICE_ACCOUNT:', err);
      _app = initializeApp({ projectId: 'hy3n26' });
    }
  } else {
    // Application Default Credentials (Cloud Run, GCE, etc.)
    _app = initializeApp({ projectId: 'hy3n26' });
  }

  console.log('[Firebase Admin] Initialized');
  return _app;
}

function getDb(): Firestore {
  return getFirestore(getAdminApp());
}

// ─── Collection constants ─────────────────────────────────────────────────────

export const ADMIN_COLLECTIONS = {
  RIDER_PROFILES: 'rider_profiles',
  RIDES: 'rides',
  WALLET: 'wallets',
  WALLET_TRANSACTIONS: 'wallet_transactions',
  SCHEDULED_RIDES: 'scheduled_rides',
  SUPPORT_TICKETS: 'support_tickets',
  LOYALTY_POINTS: 'loyalty_points',
  LOYALTY_REDEMPTIONS: 'loyalty_redemptions',
  SAVED_PLACES: 'saved_places',
  REFERRALS: 'referrals',
  SOS_INCIDENTS: 'sos_incidents',
  PROMO_CODES: 'promo_codes',
  PAYMENTS: 'payments',
  RIDE_REPORTS: 'ride_reports',
  DRIVER_PROFILES: 'driver_profiles',
  DAILY_COMMISSION: 'daily_commissions',
};

// ─── Firestore helpers ────────────────────────────────────────────────────────

/**
 * Firestore/ADC failures (bad credentials, missing IAM role, network blip) must
 * surface as a normal rejected promise here — tRPC turns that into a clean
 * per-request error. Without this, some of these failures happen deep inside
 * google-gax's internal retry/token logic on a detached tick that Node treats
 * as an unhandled rejection (fatal by default); see the process-level guard
 * in index.ts for that second layer.
 */
async function withFirestoreErrorHandling<T>(op: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.error(`[Firestore] ${op} failed:`, err);
    throw new Error("Firestore is unavailable. Check backend credentials/configuration.");
  }
}

export const adminFirestore = {
  async get(collectionName: string, id: string) {
    return withFirestoreErrorHandling(`get(${collectionName}/${id})`, async () => {
      const snap = await getDb().collection(collectionName).doc(id).get();
      if (!snap.exists) return null;
      return { id: snap.id, ...snap.data() } as Record<string, any>;
    });
  },

  async list(
    collectionName: string,
    filters: Record<string, any> = {},
    orderByField: string | null = 'created_date',
    orderDir: 'asc' | 'desc' = 'desc',
    limitNum?: number,
  ): Promise<Array<Record<string, any>>> {
    return withFirestoreErrorHandling(`list(${collectionName})`, async () => {
      let q = getDb().collection(collectionName) as FirebaseFirestore.Query;
      for (const [field, value] of Object.entries(filters)) {
        if (value !== undefined && value !== null) {
          q = q.where(field, '==', value);
        }
      }
      if (orderByField) {
        q = q.orderBy(orderByField, orderDir);
      }
      if (limitNum) q = q.limit(limitNum);
      const snap = await q.get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    });
  },

  async create(collectionName: string, data: Record<string, any>) {
    return withFirestoreErrorHandling(`create(${collectionName})`, async () => {
      const payload = {
        ...data,
        created_date: data.created_date || new Date().toISOString(),
        updated_date: new Date().toISOString(),
      };
      const ref = await getDb().collection(collectionName).add(payload);
      return { id: ref.id, ...payload };
    });
  },

  async update(collectionName: string, id: string, data: Record<string, any>) {
    return withFirestoreErrorHandling(`update(${collectionName}/${id})`, async () => {
      const payload = { ...data, updated_date: new Date().toISOString() };
      await getDb().collection(collectionName).doc(id).update(payload);
      return { id, ...payload };
    });
  },

  async delete(collectionName: string, id: string) {
    return withFirestoreErrorHandling(`delete(${collectionName}/${id})`, async () => {
      await getDb().collection(collectionName).doc(id).delete();
      return { id };
    });
  },

  async set(collectionName: string, id: string, data: Record<string, any>) {
    return withFirestoreErrorHandling(`set(${collectionName}/${id})`, async () => {
      const payload = {
        ...data,
        created_date: data.created_date || new Date().toISOString(),
        updated_date: new Date().toISOString(),
      };
      await getDb().collection(collectionName).doc(id).set(payload, { merge: true });
      return { id, ...payload };
    });
  },

  /**
   * Assigns a searching ride once. The Firestore transaction prevents two
   * online drivers from accepting the same offer at the same time.
   */
  async claimSearchingRide(rideId: string, driverId: string, data: Record<string, any>) {
    return withFirestoreErrorHandling(`claimSearchingRide(${rideId})`, async () => {
      const db = getDb();
      const ref = db.collection(ADMIN_COLLECTIONS.RIDES).doc(rideId);
      return db.runTransaction(async (transaction) => {
        const snap = await transaction.get(ref);
        if (!snap.exists) throw new Error('Ride not found.');
        const ride = { id: snap.id, ...snap.data() } as Record<string, any>;
        if (ride.status !== 'searching' || ride.driver_id) {
          throw new Error('This ride has already been accepted by another driver.');
        }
        const payload = { ...data, driver_id: driverId, updated_date: new Date().toISOString() };
        transaction.update(ref, payload);
        return { ...ride, ...payload };
      });
    });
  },

  /**
   * Settles a successful Hubtel wallet top-up exactly once. Hubtel can retry
   * callbacks and the status-reconciliation route can run concurrently, so
   * the wallet credit and transaction state change must share one Firestore
   * transaction.
   */
  async settleWalletTopUp(reference: string, hubtel: {
    transactionId?: string;
    status?: string;
    message?: string;
  }) {
    return withFirestoreErrorHandling(`settleWalletTopUp(${reference})`, async () => {
      const db = getDb();
      return db.runTransaction(async (transaction) => {
        const topupQuery = db
          .collection(ADMIN_COLLECTIONS.WALLET_TRANSACTIONS)
          .where('reference', '==', reference)
          .limit(1);
        const topupSnapshot = await transaction.get(topupQuery);

        if (topupSnapshot.empty) {
          return { found: false, settled: false, alreadyCompleted: false, newBalance: null as number | null };
        }

        const topupDoc = topupSnapshot.docs[0];
        const topup = topupDoc.data() as Record<string, any>;
        const userId = String(topup.user_id || '');
        if (!userId) {
          throw new Error('Wallet transaction is missing its user_id.');
        }

        const walletRef = db.collection(ADMIN_COLLECTIONS.WALLET).doc(userId);
        const walletSnapshot = await transaction.get(walletRef);
        const wallet = walletSnapshot.exists ? (walletSnapshot.data() || {}) : {};
        const currentBalance = Number(wallet.balance || 0);

        if (topup.status === 'completed') {
          return { found: true, settled: false, alreadyCompleted: true, newBalance: currentBalance };
        }

        if (topup.status !== 'processing') {
          return { found: true, settled: false, alreadyCompleted: false, newBalance: currentBalance };
        }

        const amount = Number(topup.amount || 0);
        if (!Number.isFinite(amount) || amount <= 0) {
          throw new Error('Wallet transaction has an invalid top-up amount.');
        }

        const totalToppedUp = Number(wallet.total_topped_up || 0);
        const now = new Date().toISOString();
        const newBalance = currentBalance + amount;

        transaction.set(walletRef, {
          user_id: userId,
          user_type: topup.user_type || wallet.user_type || 'rider',
          balance: newBalance,
          total_topped_up: totalToppedUp + amount,
          created_date: wallet.created_date || now,
          updated_date: now,
        }, { merge: true });
        transaction.update(topupDoc.ref, {
          status: 'completed',
          hubtel_transaction_id: hubtel.transactionId || topup.hubtel_transaction_id || null,
          hubtel_status: hubtel.status || 'Success',
          hubtel_message: hubtel.message || topup.hubtel_message || null,
          completed_at: now,
          updated_date: now,
        });

        return { found: true, settled: true, alreadyCompleted: false, newBalance };
      });
    });
  },
};
