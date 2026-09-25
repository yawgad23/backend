import type { Express } from 'express';
/**
 * Trusted, read-only ledger for the web admin. It deliberately reads through
 * Firebase Admin rather than direct browser Firestore, so fee records stay
 * private and only verified Firebase administrators can see them.
 */
export declare function registerAdminCommissionRoutes(app: Express): void;
