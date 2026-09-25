export declare const DRIVER_LOCATION_FRESHNESS_MS: number;
export declare function driverLocationUpdatedAtMs(profile: Record<string, any> | null | undefined): number | null;
/**
 * A Driver only appears as live when the device recently published GPS. This
 * prevents an old marker from surviving an app force-close or lost connection.
 */
export declare function hasFreshDriverLocation(profile: Record<string, any> | null | undefined, referenceMs?: number): boolean;
export declare function isOnlineWithFreshLocation(profile: Record<string, any> | null | undefined, referenceMs?: number): boolean;
export declare function profilePresencePatch(status: 'online' | 'offline' | 'busy'): {
    availability_status: "online" | "offline" | "busy";
    is_online: boolean;
    is_available: boolean;
    last_seen_at: string;
};
