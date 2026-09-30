/**
 * Firebase Admin SDK — server-side only.
 *
 * Initialisation: the service account is read from the FIREBASE_SERVICE_ACCOUNT
 * environment variable (JSON string). If not set, falls back to Application
 * Default Credentials (works on Cloud Run automatically when the runtime
 * service account has Firestore access).
 */

import { initializeApp, getApps, cert, type App } from 'firebase-admin/app';
import { FieldPath, getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { expiredRideSearchPatch, isRideSearchExpired } from './rideSearchExpiry';
import { completedTripCountAfterCompletion, driverTripCountProfilePatch } from './driverTripCounts';

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

/**
 * Server-only Firestore access for transactional operations that must not be
 * exposed through mobile clients. Callers must keep identifiers and secrets
 * out of logs.
 */
export function getAdminDb(): Firestore {
  return getFirestore(getAdminApp());
}

function getDb(): Firestore {
  return getAdminDb();
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
  RIDE_EVENTS: 'ride_events',
  TRIP_SHARES: 'trip_shares',
  DRIVER_PROFILES: 'driver_profiles',
  DAILY_COMMISSION: 'daily_commissions',
  PUSH_DEVICES: 'push_devices',
  PUSH_DELIVERIES: 'push_deliveries',
  PASSWORD_RESET_LIMITS: 'password_reset_limits',
  FINANCIAL_RECONCILIATION_AUDITS: 'financial_reconciliation_audits',
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

  /**
   * Reads an entire server-owned collection in stable pages for an audit job.
   * The explicit cap prevents a silently partial reconciliation when data grows.
   */
  async listAll(
    collectionName: string,
    pageSize = 500,
    maxRecords = 50_000,
  ): Promise<{ records: Array<Record<string, any>>; truncated: boolean }> {
    return withFirestoreErrorHandling(`listAll(${collectionName})`, async () => {
      const records: Array<Record<string, any>> = [];
      let lastDocument: FirebaseFirestore.QueryDocumentSnapshot | null = null;

      while (records.length < maxRecords) {
        const remaining = maxRecords - records.length;
        let query: FirebaseFirestore.Query = getDb()
          .collection(collectionName)
          .orderBy(FieldPath.documentId())
          .limit(Math.min(pageSize, remaining));
        if (lastDocument) query = query.startAfter(lastDocument);
        const snapshot = await query.get();
        if (snapshot.empty) return { records, truncated: false };
        records.push(...snapshot.docs.map((document) => ({ id: document.id, ...document.data() })));
        lastDocument = snapshot.docs[snapshot.docs.length - 1];
        if (snapshot.size < Math.min(pageSize, remaining)) return { records, truncated: false };
      }

      let nextQuery: FirebaseFirestore.Query = getDb()
        .collection(collectionName)
        .orderBy(FieldPath.documentId())
        .limit(1);
      if (lastDocument) nextQuery = nextQuery.startAfter(lastDocument);
      const nextPage = await nextQuery.get();
      return { records, truncated: !nextPage.empty };
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

  /**
   * Creates the Driver's emergency incident and the matching critical support
   * ticket in one Firestore batch. An SOS is only acknowledged once both the
   * incident record and the Safety queue entry exist.
   */
  async createSosIncidentWithTicket(
    incidentData: Record<string, any>,
    ticketData: Record<string, any>,
  ) {
    return withFirestoreErrorHandling('createSosIncidentWithTicket', async () => {
      const db = getDb();
      const incidentRef = db.collection(ADMIN_COLLECTIONS.SOS_INCIDENTS).doc();
      const ticketRef = db.collection(ADMIN_COLLECTIONS.SUPPORT_TICKETS).doc();
      const timestamp = new Date().toISOString();
      const incident: Record<string, any> = {
        ...incidentData,
        id: incidentRef.id,
        created_date: incidentData.created_date || timestamp,
        updated_date: timestamp,
      };
      const ticket = {
        ...ticketData,
        id: ticketRef.id,
        incident_id: incidentRef.id,
        created_date: ticketData.created_date || timestamp,
        updated_date: timestamp,
      };
      incident.support_ticket_id = ticketRef.id;

      const batch = db.batch();
      batch.set(incidentRef, incident);
      batch.set(ticketRef, ticket);
      await batch.commit();
      return { incident, ticket };
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
        if (isRideSearchExpired(ride)) {
          const expired = expiredRideSearchPatch();
          transaction.update(ref, expired);
          return { ...ride, ...expired };
        }
        const payload = { ...data, driver_id: driverId, updated_date: new Date().toISOString() };
        transaction.update(ref, payload);
        return { ...ride, ...payload };
      });
    });
  },

  /**
   * Writes a ride patch only while its current server state is in the supplied
   * set. This prevents a cancellation request racing a Start Trip or Complete
   * request from overwriting a chargeable trip with a terminal cancellation.
   */
  async updateRideIfStatus(rideId: string, allowedStatuses: string[], data: Record<string, any>): Promise<Record<string, any>> {
    return withFirestoreErrorHandling(`updateRideIfStatus(${rideId})`, async () => {
      const db = getDb();
      const ref = db.collection(ADMIN_COLLECTIONS.RIDES).doc(rideId);
      return db.runTransaction(async (transaction) => {
        const snap = await transaction.get(ref);
        if (!snap.exists) throw new Error('Ride not found.');
        const ride = { id: snap.id, ...snap.data() } as Record<string, any>;
        const status = String(ride.status || '').trim().toLowerCase();
        if (!allowedStatuses.includes(status)) {
          throw new Error('This ride is no longer eligible for that action.');
        }
        const payload = { ...data, updated_date: new Date().toISOString() };
        transaction.update(ref, payload);
        return { ...ride, ...payload };
      });
    });
  },

  /**
   * Completes a started ride and writes the Driver's lifetime trip total from
   * completed ride records in the same transaction. A profile counter is never
   * accepted from a mobile client, and a replay cannot increment it twice.
   */
  async completeRideAndSynchronizeDriverTripCount(
    rideId: string,
    driverId: string,
    data: Record<string, any>,
  ): Promise<{ ride: Record<string, any>; totalTrips: number }> {
    return withFirestoreErrorHandling(`completeRideAndSynchronizeDriverTripCount(${rideId})`, async () => {
      const db = getDb();
      const rideRef = db.collection(ADMIN_COLLECTIONS.RIDES).doc(rideId);
      const driverRidesQuery = db.collection(ADMIN_COLLECTIONS.RIDES).where('driver_id', '==', driverId);
      const driverProfilesQuery = db.collection(ADMIN_COLLECTIONS.DRIVER_PROFILES).where('user_id', '==', driverId);

      return db.runTransaction(async (transaction) => {
        // All reads are performed before writes, as required by Firestore
        // transactions. The queries make a historical profile counter repair
        // part of every successful completion without relying on a client.
        const [rideSnap, driverRidesSnap, driverProfilesSnap] = await Promise.all([
          transaction.get(rideRef),
          transaction.get(driverRidesQuery),
          transaction.get(driverProfilesQuery),
        ]);
        if (!rideSnap.exists) throw new Error('Ride not found.');

        const ride = { id: rideSnap.id, ...rideSnap.data() } as Record<string, any>;
        if (String(ride.status || '').trim().toLowerCase() !== 'in_progress') {
          throw new Error('This ride is no longer eligible for completion.');
        }
        if (String(ride.driver_id || '').trim() !== driverId) {
          throw new Error('This ride is assigned to another driver.');
        }

        const historicalRides = driverRidesSnap.docs.map((document) => ({ id: document.id, ...document.data() }));
        const totalTrips = completedTripCountAfterCompletion(historicalRides, driverId, rideId);
        const timestamp = new Date().toISOString();
        const ridePatch = { ...data, driver_id: driverId, updated_date: timestamp };
        const profilePatch = driverTripCountProfilePatch(driverId, totalTrips, timestamp);
        const profileIds = new Set<string>([driverId, ...driverProfilesSnap.docs.map((document) => document.id)]);

        transaction.update(rideRef, ridePatch);
        for (const profileId of profileIds) {
          transaction.set(db.collection(ADMIN_COLLECTIONS.DRIVER_PROFILES).doc(profileId), profilePatch, { merge: true });
        }

        return { ride: { ...ride, ...ridePatch }, totalTrips };
      });
    });
  },

  /**
   * Claims a completed ride's receipt delivery before SMTP is called. The Rider
   * app and the Driver completion request can arrive at almost the same time,
   * so a normal read followed by a write can send two identical receipts.
   * A Firestore transaction makes one caller the sender and makes every other
   * caller observe the same sent/in-progress state.
   */
  async claimReceiptEmailDelivery(rideId: string, recipientEmail: string, staleAfterMs = 15 * 60 * 1000) {
    return withFirestoreErrorHandling(`claimReceiptEmailDelivery(${rideId})`, async () => {
      const db = getDb();
      const ref = db.collection(ADMIN_COLLECTIONS.RIDES).doc(rideId);
      return db.runTransaction(async (transaction) => {
        const snap = await transaction.get(ref);
        if (!snap.exists) throw new Error('Ride not found.');
        const ride = snap.data() as Record<string, any>;
        const status = String(ride.receipt_email_delivery_status || '');

        if (ride.receipt_email_sent === true || status === 'sent') {
          return { claimed: false, state: 'sent' as const };
        }

        const deliveryStartedAt = new Date(String(ride.receipt_email_delivery_started_at || '')).getTime();
        const hasFreshDeliveryLock = status === 'sending'
          && Number.isFinite(deliveryStartedAt)
          && Date.now() - deliveryStartedAt >= 0
          && Date.now() - deliveryStartedAt < staleAfterMs;
        if (hasFreshDeliveryLock) {
          return { claimed: false, state: 'sending' as const };
        }

        const timestamp = new Date().toISOString();
        transaction.update(ref, {
          rider_email: recipientEmail,
          receipt_email_delivery_status: 'sending',
          receipt_email_delivery_started_at: timestamp,
          receipt_email_last_attempt_at: timestamp,
          updated_date: timestamp,
        });
        return { claimed: true, state: 'sending' as const };
      });
    });
  },

  /** Complete the receipt delivery state after the caller that owns the lock finishes SMTP. */
  async finishReceiptEmailDelivery(rideId: string, recipientEmail: string, sent: boolean) {
    return withFirestoreErrorHandling(`finishReceiptEmailDelivery(${rideId})`, async () => {
      const timestamp = new Date().toISOString();
      await getDb().collection(ADMIN_COLLECTIONS.RIDES).doc(rideId).update(sent
        ? {
            rider_email: recipientEmail,
            receipt_email_sent: true,
            receipt_email_sent_at: timestamp,
            receipt_email_delivery_status: 'sent',
            receipt_email_last_status: 'sent',
            updated_date: timestamp,
          }
        : {
            rider_email: recipientEmail,
            receipt_email_delivery_status: 'failed',
            receipt_email_last_status: 'failed',
            receipt_email_last_attempt_at: timestamp,
            updated_date: timestamp,
          });
      return { sent, completedAt: timestamp };
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
