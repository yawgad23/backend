import type { Express } from 'express';
/**
 * Admin-only account lifecycle controls. Account removal disables the Firebase
 * login and removes profile documents, while payment, ride, and commission
 * records remain in place for operational and financial audit history.
 */
export declare function registerAdminAccountRoutes(app: Express): void;
