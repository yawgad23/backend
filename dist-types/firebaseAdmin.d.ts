/**
 * Firebase Admin SDK — server-side only.
 *
 * Initialisation: the service account is read from the FIREBASE_SERVICE_ACCOUNT
 * environment variable (JSON string). If not set, falls back to Application
 * Default Credentials (works on Cloud Run automatically when the runtime
 * service account has Firestore access).
 */
export declare function getAdminAuth(): import("firebase-admin/auth").Auth;
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
    RIDE_EVENTS: string;
    TRIP_SHARES: string;
    DRIVER_PROFILES: string;
    DAILY_COMMISSION: string;
    PUSH_DEVICES: string;
    PUSH_DELIVERIES: string;
};
export declare const adminFirestore: {
    get(collectionName: string, id: string): Promise<Record<string, any> | null>;
    list(collectionName: string, filters?: Record<string, any>, orderByField?: string | null, orderDir?: "asc" | "desc", limitNum?: number): Promise<Array<Record<string, any>>>;
    create(collectionName: string, data: Record<string, any>): Promise<{
        created_date: any;
        updated_date: string;
        id: string;
    }>;
    /**
     * Creates the Driver's emergency incident and the matching critical support
     * ticket in one Firestore batch. An SOS is only acknowledged once both the
     * incident record and the Safety queue entry exist.
     */
    createSosIncidentWithTicket(incidentData: Record<string, any>, ticketData: Record<string, any>): Promise<{
        incident: Record<string, any>;
        ticket: {
            id: string;
            incident_id: string;
            created_date: any;
            updated_date: string;
        };
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
    /**
     * Assigns a searching ride once. The Firestore transaction prevents two
     * online drivers from accepting the same offer at the same time.
     */
    claimSearchingRide(rideId: string, driverId: string, data: Record<string, any>): Promise<{
        driver_id: string;
        updated_date: string;
    }>;
    /**
     * Settles a successful Hubtel wallet top-up exactly once. Hubtel can retry
     * callbacks and the status-reconciliation route can run concurrently, so
     * the wallet credit and transaction state change must share one Firestore
     * transaction.
     */
    settleWalletTopUp(reference: string, hubtel: {
        transactionId?: string;
        status?: string;
        message?: string;
    }): Promise<{
        found: boolean;
        settled: boolean;
        alreadyCompleted: boolean;
        newBalance: number | null;
    }>;
};
