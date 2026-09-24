import type { Express } from 'express';
type Point = {
    latitude: number;
    longitude: number;
};
/** Securely stores the per-activity APNs token and its paired FCM token. */
export declare function registerLiveActivityRoutes(app: Express): void;
/** Sends a throttled remote ActivityKit update for one Rider trip. */
export declare function sendRideLiveActivityUpdate(ride: Record<string, any>, options?: {
    driverLocation?: Point;
    force?: boolean;
}): Promise<{
    attempted: number;
    sent: number;
}>;
/** Emits a Driver GPS update to every active ride owned by that Driver. */
export declare function sendDriverLocationLiveActivityUpdates(driverId: string, driverLocation: Point): Promise<void>;
export {};
