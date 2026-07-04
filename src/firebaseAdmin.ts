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

// ─── App singleton ────────────────────────────────────────────────────────────

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

export const adminFirestore = {
  async get(collectionName: string, id: string) {
    const snap = await getDb().collection(collectionName).doc(id).get();
    if (!snap.exists) return null;
    return { id: snap.id, ...snap.data() } as Record<string, any>;
  },

  async list(
    collectionName: string,
    filters: Record<string, any> = {},
    orderByField = 'created_date',
    orderDir: 'asc' | 'desc' = 'desc',
    limitNum?: number,
  ): Promise<Array<Record<string, any>>> {
    let q = getDb().collection(collectionName) as FirebaseFirestore.Query;
    for (const [field, value] of Object.entries(filters)) {
      if (value !== undefined && value !== null) {
        q = q.where(field, '==', value);
      }
    }
    try {
      q = q.orderBy(orderByField, orderDir);
    } catch {
      // orderBy may fail if composite index not ready — skip silently
    }
    if (limitNum) q = q.limit(limitNum);
    const snap = await q.get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },

  async create(collectionName: string, data: Record<string, any>) {
    const payload = {
      ...data,
      created_date: data.created_date || new Date().toISOString(),
      updated_date: new Date().toISOString(),
    };
    const ref = await getDb().collection(collectionName).add(payload);
    return { id: ref.id, ...payload };
  },

  async update(collectionName: string, id: string, data: Record<string, any>) {
    const payload = { ...data, updated_date: new Date().toISOString() };
    await getDb().collection(collectionName).doc(id).update(payload);
    return { id, ...payload };
  },

  async delete(collectionName: string, id: string) {
    await getDb().collection(collectionName).doc(id).delete();
    return { id };
  },

  async set(collectionName: string, id: string, data: Record<string, any>) {
    const payload = {
      ...data,
      created_date: data.created_date || new Date().toISOString(),
      updated_date: new Date().toISOString(),
    };
    await getDb().collection(collectionName).doc(id).set(payload, { merge: true });
    return { id, ...payload };
  },
};
