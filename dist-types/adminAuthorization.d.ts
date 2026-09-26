import type { Request, Response } from 'express';
/** Verifies the Firebase identity plus server-side administrator record only. */
export declare function requireAdministratorIdentity(request: Request, response: Response): Promise<string | null>;
/**
 * Protects every operational admin endpoint with both the administrator
 * identity and the short-lived, server-signed access-code proof.
 */
export declare function requireAdministrator(request: Request, response: Response): Promise<string | null>;
