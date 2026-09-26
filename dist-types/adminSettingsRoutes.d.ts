import type { Express } from 'express';
/**
 * Settings and access controls for the dedicated admin dashboard. Every route
 * verifies a Firebase ID token on the server; no PIN, email allow-list, or
 * setting value is trusted from the browser.
 */
export declare function registerAdminSettingsRoutes(app: Express): void;
