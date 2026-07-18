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
                clientReference: string;
                commissionRecord: {
                    created_date: any;
                    updated_date: string;
                    id: string;
                } | null;
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
                newStatus: "paid" | "failed" | "processing";
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
