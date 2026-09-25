export declare function receiptEmail(value: unknown): string;
export type ReceiptDeliveryState = 'ready' | 'sending' | 'sent';
/** A pure state reader used by receipt idempotency coverage. */
export declare function receiptDeliveryState(ride: Record<string, any>, currentTime?: number): ReceiptDeliveryState;
/**
 * Send one receipt per completed ride. Driver completion and older Rider
 * clients share the same Firestore lock so they cannot race to SMTP.
 */
export declare function sendCompletedRideReceipt(rideId: string, suppliedRide?: Record<string, any>): Promise<{
    sent: boolean;
    alreadySent: boolean;
    pending: boolean;
    missingRecipient: boolean;
}>;
export declare function driverRideCategories(profileData: Record<string, any>): string[];
export declare function driverCanServeRideCategory(profileData: Record<string, any>, category: unknown): boolean;
export declare const driverOperations: import("@trpc/server").TRPCBuiltRouter<{
    ctx: import("./context").TrpcContext;
    meta: object;
    errorShape: import("@trpc/server").TRPCDefaultErrorShape;
    transformer: true;
}, import("@trpc/server").TRPCDecorateCreateRouterOptions<{
    getPreferences: import("@trpc/server").TRPCQueryProcedure<{
        input: {
            driverId: string;
        };
        output: {
            preferences: {
                rideCategories: any;
                pickupRadiusKm: any;
                autoAccept: boolean;
                longTripsOnly: boolean;
                preferHighRated: boolean;
                destination: any;
                destinationUsesRemaining: number;
            };
        };
        meta: object;
    }>;
    savePreferences: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            driverId: string;
            rideCategories: string[];
            pickupRadiusKm: number;
            autoAccept: boolean;
            destination?: {
                label: string;
                latitude: number;
                longitude: number;
            } | undefined;
        };
        output: {
            preferences: any;
            destinationUsesRemaining: number;
        };
        meta: object;
    }>;
    clearDestinationFilter: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            driverId: string;
        };
        output: {
            success: boolean;
            preferences: any;
        };
        meta: object;
    }>;
    setAvailability: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            driverId: string;
            status: "online" | "offline" | "busy";
        };
        output: {
            success: boolean;
            status: "online" | "offline" | "busy";
        };
        meta: object;
    }>;
    updateLocation: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            driverId: string;
            latitude: number;
            longitude: number;
            heading?: number | undefined;
            speedKmh?: number | undefined;
        };
        output: {
            success: boolean;
            location: {
                latitude: number;
                longitude: number;
                heading: number | null;
                speedKmh: number | null;
                recorded_at: string;
            };
        };
        meta: object;
    }>;
}>>;
export declare const driverTrips: import("@trpc/server").TRPCBuiltRouter<{
    ctx: import("./context").TrpcContext;
    meta: object;
    errorShape: import("@trpc/server").TRPCDefaultErrorShape;
    transformer: true;
}, import("@trpc/server").TRPCDecorateCreateRouterOptions<{
    history: import("@trpc/server").TRPCQueryProcedure<{
        input: {
            driverId: string;
        };
        output: {
            rides: Record<string, any>[];
        };
        meta: object;
    }>;
    rateRider: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            driverId: string;
            rideId: string;
            riderId: string;
            rating: number;
            feedback?: string | undefined;
            foundItem?: string | undefined;
            safetyReport?: string | undefined;
        };
        output: {
            success: boolean;
            warnings: string[];
        };
        meta: object;
    }>;
    availableOffers: import("@trpc/server").TRPCQueryProcedure<{
        input: {
            driverId: string;
        };
        output: {
            offers: {
                pickup_distance_km: number | null;
            }[];
        };
        meta: object;
    }>;
    activateQueued: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            driverId: string;
            rideId: string;
            completedRideId?: string | undefined;
        };
        output: {
            success: boolean;
            ride: Record<string, any>;
        };
        meta: object;
    }>;
    respondToOffer: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            driverId: string;
            rideId: string;
            decision: "accept" | "decline";
            driverName?: string | undefined;
            vehicle_make?: string | undefined;
            vehicle_model?: string | undefined;
            vehicle_plate?: string | undefined;
            license_plate?: string | undefined;
            vehicle_color?: string | undefined;
            vehicle_colour?: string | undefined;
            vehicle_colour_hex?: string | undefined;
            vehicle_full_model?: string | undefined;
            queueAfterRideId?: string | undefined;
        };
        output: {
            success: boolean;
            ride: Record<string, any>;
            decision: "decline";
        } | {
            success: boolean;
            ride: {
                driver_id: string;
                updated_date: string;
            };
            decision: "accept";
        };
        meta: object;
    }>;
    arrive: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            driverId: string;
            rideId: string;
        };
        output: {
            success: boolean;
            ride: Record<string, any>;
        };
        meta: object;
    }>;
    verifyPickup: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            driverId: string;
            rideId: string;
            pickupCode: string;
        };
        output: {
            success: boolean;
            ride: Record<string, any>;
        };
        meta: object;
    }>;
    start: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            driverId: string;
            rideId: string;
            waitingTimeMinutes?: number | undefined;
            waitingFee?: number | undefined;
            startLocation?: {
                latitude: number;
                longitude: number;
            } | undefined;
        };
        output: {
            success: boolean;
            ride: Record<string, any>;
        };
        meta: object;
    }>;
    recordTripLocation: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            driverId: string;
            rideId: string;
            latitude: number;
            longitude: number;
            recordedAt?: string | undefined;
        };
        output: {
            success: boolean;
            accepted: boolean;
            incrementKm: number;
            ignoredReason: "invalid" | "noise" | "jump" | null;
            actualDistanceKm: number;
        };
        meta: object;
    }>;
    complete: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            driverId: string;
            rideId: string;
            finalFare?: number | undefined;
            tipAmount?: number | undefined;
            actualDistanceKm?: number | undefined;
            actualDurationMinutes?: number | undefined;
            fareBreakdown?: any;
        };
        output: {
            success: boolean;
            ride: Record<string, any>;
            driverEarnings: number;
        };
        meta: object;
    }>;
    cancel: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            driverId: string;
            rideId: string;
            reason: string;
        };
        output: {
            success: boolean;
            ride: Record<string, any>;
        };
        meta: object;
    }>;
}>>;
export declare const driverSafety: import("@trpc/server").TRPCBuiltRouter<{
    ctx: import("./context").TrpcContext;
    meta: object;
    errorShape: import("@trpc/server").TRPCDefaultErrorShape;
    transformer: true;
}, import("@trpc/server").TRPCDecorateCreateRouterOptions<{
    createSos: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            driverId: string;
            driverName?: string | undefined;
            rideId?: string | undefined;
            message?: string | undefined;
            location?: {
                latitude: number;
                longitude: number;
            } | undefined;
        };
        output: {
            success: boolean;
            incident: {
                created_date: any;
                updated_date: string;
                id: string;
            };
        };
        meta: object;
    }>;
    recordDrivingEvent: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            driverId: string;
            type: string;
            rideId?: string | undefined;
            previousSpeedKmh?: number | undefined;
            currentSpeedKmh?: number | undefined;
            location?: {
                latitude: number;
                longitude: number;
            } | undefined;
        };
        output: {
            success: boolean;
            event: {
                created_date: any;
                updated_date: string;
                id: string;
            };
        };
        meta: object;
    }>;
    reportRoadHazard: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            driverId: string;
            type: string;
            latitude: number;
            longitude: number;
            description?: string | undefined;
        };
        output: {
            success: boolean;
            hazard: {
                created_date: any;
                updated_date: string;
                id: string;
            };
        };
        meta: object;
    }>;
}>>;
export declare const driverFinance: import("@trpc/server").TRPCBuiltRouter<{
    ctx: import("./context").TrpcContext;
    meta: object;
    errorShape: import("@trpc/server").TRPCDefaultErrorShape;
    transformer: true;
}, import("@trpc/server").TRPCDecorateCreateRouterOptions<{
    getOverview: import("@trpc/server").TRPCQueryProcedure<{
        input: {
            driverId: string;
            period?: "month" | "today" | "week" | undefined;
        };
        output: {
            totals: {
                gross: number;
                net: number;
                tips: number;
                dailyPlatformFee: number;
                dailyFeeDays: number;
                tripCount: number;
                averagePerTrip: number;
                availableBalance: number;
            };
            dailyFee: {
                amount: number;
                status: string;
                date: string;
            };
            trend: {
                date: string;
                amount: number;
            }[];
            goals: never[];
            goal: {
                amount: number;
                progress: number;
                percent: number;
            } | null;
            payoutMethod: any;
        };
        meta: object;
    }>;
    listIncentives: import("@trpc/server").TRPCQueryProcedure<{
        input: {
            driverId: string;
        };
        output: {
            incentives: Record<string, any>[];
        };
        meta: object;
    }>;
    saveGoal: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            driverId: string;
            period: "month" | "today" | "week";
            targetAmount: number;
        };
        output: {
            success: boolean;
            goal: {
                created_date: any;
                updated_date: string;
                id: string;
            };
        };
        meta: object;
    }>;
    savePayoutMethod: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            driverId: string;
            provider: string;
            accountNumber: string;
            accountHolder: string;
        };
        output: {
            success: boolean;
            payoutMethod: {
                provider: string;
                accountHolder: string;
                accountNumberMasked: string;
                updatedAt: string;
            };
        };
        meta: object;
    }>;
    requestPayout: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            driverId: string;
            amount: number;
        };
        output: {
            success: boolean;
            request: {
                created_date: any;
                updated_date: string;
                id: string;
            };
        };
        meta: object;
    }>;
}>>;
export declare const driverPerformance: import("@trpc/server").TRPCBuiltRouter<{
    ctx: import("./context").TrpcContext;
    meta: object;
    errorShape: import("@trpc/server").TRPCDefaultErrorShape;
    transformer: true;
}, import("@trpc/server").TRPCDecorateCreateRouterOptions<{
    getOverview: import("@trpc/server").TRPCQueryProcedure<{
        input: {
            driverId: string;
        };
        output: {
            metrics: {
                acceptanceRate: number;
                cancellationRate: number;
                rating: number;
                ratingsCount: number;
                completedTrips: number;
            };
        };
        meta: object;
    }>;
}>>;
export declare const driverScheduling: import("@trpc/server").TRPCBuiltRouter<{
    ctx: import("./context").TrpcContext;
    meta: object;
    errorShape: import("@trpc/server").TRPCDefaultErrorShape;
    transformer: true;
}, import("@trpc/server").TRPCDecorateCreateRouterOptions<{
    listAvailable: import("@trpc/server").TRPCQueryProcedure<{
        input: {
            driverId: string;
            limit?: number | undefined;
        };
        output: {
            rides: Record<string, any>[];
        };
        meta: object;
    }>;
    reserve: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            driverId: string;
            rideId: string;
            driverName?: string | undefined;
        };
        output: {
            success: boolean;
            ride: Record<string, any>;
        };
        meta: object;
    }>;
    release: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            driverId: string;
            rideId: string;
        };
        output: {
            success: boolean;
            ride: Record<string, any>;
        };
        meta: object;
    }>;
}>>;
export declare const driverSupport: import("@trpc/server").TRPCBuiltRouter<{
    ctx: import("./context").TrpcContext;
    meta: object;
    errorShape: import("@trpc/server").TRPCDefaultErrorShape;
    transformer: true;
}, import("@trpc/server").TRPCDecorateCreateRouterOptions<{
    listTickets: import("@trpc/server").TRPCQueryProcedure<{
        input: {
            driverId: string;
        };
        output: {
            tickets: Record<string, any>[];
        };
        meta: object;
    }>;
    createTicket: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            driverId: string;
            category: string;
            message: string;
            subject?: string | undefined;
        };
        output: {
            success: boolean;
            ticket: {
                created_date: any;
                updated_date: string;
                id: string;
            };
        };
        meta: object;
    }>;
}>>;
export declare const checkPaidToday: import("@trpc/server").TRPCQueryProcedure<{
    input: {
        driverId: string;
    };
    output: {
        paid: boolean;
        isPaid: boolean;
        status: string;
        amount: number;
        date: string;
        record: Record<string, any>;
    };
    meta: object;
}>;
