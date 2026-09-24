import type { Express } from 'express';
export declare function normalizeGhanaPhone(phoneInput: string): string | null;
/**
 * Driver MoMo-number verification using Hubtel's Programmable SMS gateway.
 * Credentials live only in Firebase Secret Manager. These routes intentionally
 * use a Firebase ID token, so one Driver cannot request codes for another
 * profile or verify a code against someone else's account.
 */
export declare function registerDriverOtpRoutes(app: Express): void;
