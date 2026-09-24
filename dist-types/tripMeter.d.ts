export type MeterLocation = {
    latitude: number;
    longitude: number;
    recordedAt?: string;
};
export type TripMeter = {
    version: 1;
    started_at: string;
    last_accepted_location: MeterLocation | null;
    last_accepted_at: string | null;
    last_observed_at: string | null;
    distance_km: number;
    accepted_samples: number;
    ignored_noise_samples: number;
    ignored_jump_samples: number;
};
export declare function haversineKilometres(from: MeterLocation, to: MeterLocation): number;
export declare function initializeTripMeter(startedAt: string, initialLocation?: Partial<MeterLocation> | null): TripMeter;
export declare function advanceTripMeter(existing: unknown, observation: Partial<MeterLocation>, observedAt: string): {
    meter: TripMeter;
    accepted: boolean;
    incrementKm: number;
    ignoredReason?: 'invalid' | 'noise' | 'jump';
};
