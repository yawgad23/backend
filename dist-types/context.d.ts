/**
 * No procedure in routers.ts reads the request/response, so the context is
 * intentionally empty. Keeping it free of Express types means consumers that
 * only need `AppRouter` for client-side type inference never have to resolve
 * Express's types themselves.
 */
export type TrpcContext = Record<string, never>;
export declare function createContext(): Promise<TrpcContext>;
