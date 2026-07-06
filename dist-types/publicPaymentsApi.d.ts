/**
 * Public Payments API
 *
 * Standalone REST endpoints (separate from the internal tRPC router in
 * routers.ts) that let *external* mobile app clients trigger a Hubtel Direct
 * Receive Money (mobile money) charge over plain HTTP + Basic Auth.
 *
 * This exists alongside `commission.charge` (tRPC) because that procedure is
 * only ever called by the HY3N apps themselves. Third-party clients need a
 * stable REST contract and their own credential pair, so charges initiated
 * here are tracked in the generic `payments` Firestore collection instead of
 * `daily_commissions`.
 *
 * Auth: every request must include `Authorization: Basic base64(username:password)`,
 * checked against PUBLIC_PAYMENTS_API_USERNAME / PUBLIC_PAYMENTS_API_PASSWORD.
 */
import type { Express } from "express";
export declare function registerPublicPaymentsApi(app: Express): void;
