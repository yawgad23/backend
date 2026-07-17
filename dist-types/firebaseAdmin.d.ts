/**
 * Firebase Admin SDK — server-side only.
 *
 * Initialisation: the service account is read from the FIREBASE_SERVICE_ACCOUNT
 * environment variable (JSON string). If not set, falls back to Application
 * Default Credentials (works on Cloud Run automatically when the runtime
 * service account has Firestore access).
 */
export declare const ADMIN_COLLECTIONS: {
    RIDER_PROFILES: string;
    RIDES: string;
    WALLET: string;
    WALLET_TRANSACTIONS: string;
    SCHEDULED_RIDES: string;
    SUPPORT_TICKETS: string;
    LOYALTY_POINTS: string;
    LOYALTY_REDEMPTIONS: string;
    SAVED_PLACES: string;
    REFERRALS: string;
    SOS_INCIDENTS: string;
    PROMO_CODES: string;
    PAYMENTS: string;
    RIDE_REPORTS: string;
    DRIVER_PROFILES: string;
    DAILY_COMMISSION: string;
};
export declare const adminFirestore: {
    get(collectionName: string, id: string): Promise<Record<string, any> | null>;
    list(collectionName: string, filters?: Record<string, any>, orderByField?: string | null, orderDir?: "asc" | "desc", limitNum?: number): Promise<Array<Record<string, any>>>;
    create(collectionName: string, data: Record<string, any>): Promise<{
        created_date: any;
        updated_date: string;
        id: string;
    }>;
    update(collectionName: string, id: string, data: Record<string, any>): Promise<{
        updated_date: string;
        id: string;
    }>;
    delete(collectionName: string, id: string): Promise<{
        id: string;
    }>;
    set(collectionName: string, id: string, data: Record<string, any>): Promise<{
        created_date: any;
        updated_date: string;
        id: string;
    }>;
};
