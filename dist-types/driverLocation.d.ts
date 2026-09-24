import type { Express } from 'express';
/**
 * Authenticated location ingress used by foreground and iOS background Driver
 * location updates. A Firebase ID token establishes the Driver ID; callers can
 * never select another Driver profile in the request body.
 */
export declare function registerDriverLocationRoutes(app: Express): void;
