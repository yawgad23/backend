export declare const appRouter: import("@trpc/server").TRPCBuiltRouter<{
    ctx: import("./context").TrpcContext;
    meta: object;
    errorShape: import("@trpc/server").TRPCDefaultErrorShape;
    transformer: true;
}, import("@trpc/server").TRPCDecorateCreateRouterOptions<{
    trips: import("@trpc/server").TRPCBuiltRouter<{
        ctx: import("./context").TrpcContext;
        meta: object;
        errorShape: import("@trpc/server").TRPCDefaultErrorShape;
        transformer: true;
    }, import("@trpc/server").TRPCDecorateCreateRouterOptions<{
        sendReceipt: import("@trpc/server").TRPCMutationProcedure<{
            input: {
                riderEmail: string;
                riderName: string;
                driverName: string;
                driverVehicle: string;
                driverPlate: string;
                pickup: string;
                destination: string;
                fare: number;
                paymentMethod: string;
                tripId: string;
                completedAt: string;
                distance?: number | undefined;
                duration?: number | undefined;
                category?: string | undefined;
            };
            output: {
                success: boolean;
            };
            meta: object;
        }>;
    }>>;
    transactionStatus: import("@trpc/server").TRPCBuiltRouter<{
        ctx: import("./context").TrpcContext;
        meta: object;
        errorShape: import("@trpc/server").TRPCDefaultErrorShape;
        transformer: true;
    }, import("@trpc/server").TRPCDecorateCreateRouterOptions<{
        check: import("@trpc/server").TRPCQueryProcedure<{
            input: {
                clientReference: string;
            };
            output: any;
            meta: object;
        }>;
    }>>;
    commission: import("@trpc/server").TRPCBuiltRouter<{
        ctx: import("./context").TrpcContext;
        meta: object;
        errorShape: import("@trpc/server").TRPCDefaultErrorShape;
        transformer: true;
    }, import("@trpc/server").TRPCDecorateCreateRouterOptions<{
        /**
         * Charge a driver's daily commission via Hubtel Direct Receive Money.
         * The driver receives a USSD prompt on their phone to approve the payment.
         *
         * Returns:
         *   - success: true if Hubtel accepted the charge request
         *   - status: "pending" (USSD sent, awaiting driver approval) | "failed"
         *   - transactionId: Hubtel's transaction reference
         *   - message: human-readable status message
         */
        charge: import("@trpc/server").TRPCMutationProcedure<{
            input: {
                driverId: string;
                driverName: string;
                momoNumber: string;
                serviceType: string;
                momoNetwork?: string | undefined;
                date?: string | undefined;
            };
            output: {
                success: boolean;
                status: string;
                transactionId: string | null;
                message: string;
                amount: number;
                date: string;
                feeSource: "default" | "firestore";
                clientReference: string;
                commissionRecord: {
                    created_date: any;
                    updated_date: string;
                    id: string;
                } | null;
            };
            meta: object;
        }>;
        /** Current global fee, used by Driver screens before a payment is made. */
        getPlatformFee: import("@trpc/server").TRPCQueryProcedure<{
            input: {
                serviceType?: string | undefined;
            } | undefined;
            output: import("./platformFee").PlatformFeeSetting;
            meta: object;
        }>;
        /**
         * Updates the global daily driver charge. The administrator PIN is checked
         * again here rather than trusting a browser-only dashboard session.
         */
        updatePlatformFee: import("@trpc/server").TRPCMutationProcedure<{
            input: {
                amount: number;
                adminPin: string;
                serviceType?: string | undefined;
            };
            output: {
                success: boolean;
                fee: import("./platformFee").PlatformFeeSetting;
            };
            meta: object;
        }>;
        /**
         * Get the commission status for a driver on a given date.
         * Used by the driver app to check if today's fee has been paid.
         *
         * Note: The Firestore record is the source of truth for the app UI —
         * the driver app writes/reads directly from Firestore. This endpoint
         * just returns the reference so the client can look it up.
         */
        getStatus: import("@trpc/server").TRPCQueryProcedure<{
            input: {
                driverId: string;
                date?: string | undefined;
            };
            output: {
                driverId: string;
                date: string;
                clientReference: any;
            };
            meta: object;
        }>;
        sendOtp: import("@trpc/server").TRPCMutationProcedure<{
            input: {
                phoneNumber: string;
                driverId: string;
            };
            output: {
                success: boolean;
                message: string;
                otpCode: string;
            };
            meta: object;
        }>;
        verifyOtp: import("@trpc/server").TRPCMutationProcedure<{
            input: {
                driverId: string;
                code: string;
            };
            output: {
                success: boolean;
                message: string;
            };
            meta: object;
        }>;
        /**
         * Admin: List all commissions for a date range.
         * Gated by the /api/admin/verify-pin check the admin dashboard performs
         * before it loads — not by per-request auth, since there's no user
         * session concept in this backend (see README).
         */
        listForAdmin: import("@trpc/server").TRPCQueryProcedure<{
            input: {
                dateFrom?: string | undefined;
                dateTo?: string | undefined;
                status?: string | undefined;
            };
            output: {
                commissions: any[];
            };
            meta: object;
        }>;
        /**
         * Admin: Override a commission status manually.
         * Same PIN-gated access model as listForAdmin above.
         */
        overrideStatus: import("@trpc/server").TRPCMutationProcedure<{
            input: {
                commissionId: string;
                newStatus: "processing" | "paid" | "failed";
                reason?: string | undefined;
            };
            output: {
                success: boolean;
                commission: {
                    updated_date: string;
                    id: string;
                };
            };
            meta: object;
        }>;
        checkPaidToday: import("@trpc/server").TRPCQueryProcedure<{
            input: {
                driverId: string;
            };
            output: {
                isPaid: boolean;
            };
            meta: object;
        }>;
    }>>;
    surge: import("@trpc/server").TRPCBuiltRouter<{
        ctx: import("./context").TrpcContext;
        meta: object;
        errorShape: import("@trpc/server").TRPCDefaultErrorShape;
        transformer: true;
    }, import("@trpc/server").TRPCDecorateCreateRouterOptions<{
        /**
         * Returns the single live surge setting. Surge is deliberately off unless
         * an administrator enables a temporary override; time of day never causes
         * a price increase by itself.
         */
        get: import("@trpc/server").TRPCQueryProcedure<{
            input: void;
            output: {
                active: boolean;
                multiplier: number;
                reason: string | null;
                updatedAt: string | null;
            };
            meta: object;
        }>;
        /** Administrator-only manual surge override, protected by the dashboard PIN. */
        update: import("@trpc/server").TRPCMutationProcedure<{
            input: {
                enabled: boolean;
                multiplier: number;
                adminPin: string;
            };
            output: {
                success: boolean;
                active: boolean;
                multiplier: number;
                updatedAt: string;
            };
            meta: object;
        }>;
    }>>;
    driverOperations: import("@trpc/server").TRPCBuiltRouter<{
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
    driverTrips: import("@trpc/server").TRPCBuiltRouter<{
        ctx: import("./context").TrpcContext;
        meta: object;
        errorShape: import("@trpc/server").TRPCDefaultErrorShape;
        transformer: true;
    }, import("@trpc/server").TRPCDecorateCreateRouterOptions<{
        activateQueued: import("@trpc/server").TRPCMutationProcedure<{
            input: {
                driverId: string;
                rideId: string;
                completedRideId?: string | undefined;
            };
            output: {
                success: boolean;
                ride: {
                    updated_date: string;
                };
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
                ride: {
                    updated_date: string;
                };
                decision: "decline";
            } | {
                success: boolean;
                ride: {
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
                ride: {
                    updated_date: string;
                };
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
                ride: {
                    updated_date: string;
                };
            };
            meta: object;
        }>;
        start: import("@trpc/server").TRPCMutationProcedure<{
            input: {
                driverId: string;
                rideId: string;
                waitingTimeMinutes?: number | undefined;
                waitingFee?: number | undefined;
            };
            output: {
                success: boolean;
                ride: {
                    updated_date: string;
                };
            };
            meta: object;
        }>;
        complete: import("@trpc/server").TRPCMutationProcedure<{
            input: {
                driverId: string;
                rideId: string;
                finalFare: number;
                tipAmount?: number | undefined;
                actualDistanceKm?: number | undefined;
                actualDurationMinutes?: number | undefined;
                fareBreakdown?: any;
            };
            output: {
                success: boolean;
                ride: {
                    updated_date: string;
                };
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
                ride: {
                    updated_date: string;
                };
            };
            meta: object;
        }>;
    }>>;
    driverSafety: import("@trpc/server").TRPCBuiltRouter<{
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
    driverFinance: import("@trpc/server").TRPCBuiltRouter<{
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
    driverPerformance: import("@trpc/server").TRPCBuiltRouter<{
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
    driverScheduling: import("@trpc/server").TRPCBuiltRouter<{
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
                ride: {
                    updated_date: string;
                };
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
                ride: {
                    updated_date: string;
                };
            };
            meta: object;
        }>;
    }>>;
    driverSupport: import("@trpc/server").TRPCBuiltRouter<{
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
    wallet: import("@trpc/server").TRPCBuiltRouter<{
        ctx: import("./context").TrpcContext;
        meta: object;
        errorShape: import("@trpc/server").TRPCDefaultErrorShape;
        transformer: true;
    }, import("@trpc/server").TRPCDecorateCreateRouterOptions<{
        /**
         * Initiate a MoMo top-up for a rider via Hubtel.
         * Sends a USSD prompt to the rider's phone.
         * The webhook at POST /api/hubtel/wallet-callback credits the wallet on success.
         */
        topup: import("@trpc/server").TRPCMutationProcedure<{
            input: {
                riderId: string;
                riderName: string;
                momoNumber: string;
                amount: number;
                momoNetwork?: string | undefined;
            };
            output: {
                success: boolean;
                message: string;
                reference: string;
                txId: string;
                status?: undefined;
                transactionId?: undefined;
            } | {
                success: boolean;
                status: string;
                message: string;
                reference: string;
                txId: string;
                transactionId: string | undefined;
            };
            meta: object;
        }>;
        /**
         * Get a user's wallet balance.
         */
        getBalance: import("@trpc/server").TRPCQueryProcedure<{
            input: {
                userId: string;
            };
            output: {
                balance: any;
                currency: string;
            };
            meta: object;
        }>;
        /**
         * Get wallet transaction history for a user.
         */
        getTransactions: import("@trpc/server").TRPCQueryProcedure<{
            input: {
                userId: string;
                limit?: number | undefined;
            };
            output: {
                transactions: Record<string, any>[];
            };
            meta: object;
        }>;
        /**
         * Settle a completed ride: deduct fare from rider wallet, credit driver wallet.
         * Called server-side when ride status changes to 'completed' with payment='wallet'.
         */
        settleRide: import("@trpc/server").TRPCMutationProcedure<{
            input: {
                rideId: string;
                riderId: string;
                driverId: string;
                driverName: string;
                riderName: string;
                fare: number;
                pickup: string;
                destination: string;
            };
            output: {
                success: boolean;
                message: string;
                newRiderBalance?: undefined;
            } | {
                success: boolean;
                newRiderBalance: number;
                message?: undefined;
            };
            meta: object;
        }>;
    }>>;
}>>;
export type AppRouter = typeof appRouter;
