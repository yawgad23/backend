import type { Request, Response } from 'express';
export declare function createAdministratorAccessProof(email: string, accessCode: string, expiresAt: number): string;
export declare function verifyAdministratorAccessProof(email: string, accessCode: string, proof: string, now?: number): boolean;
export declare function hasAdministratorAccessCode(request: Request, email: string): Promise<boolean>;
export declare function requireAdministratorAccessCode(request: Request, response: Response, email: string): Promise<boolean>;
/**
 * A code is deliberately a second factor, never a substitute for Firebase
 * authentication or the server-side admin_access authorization record.
 */
export declare function registerAdminAccessCodeRoutes(app: import('express').Express): void;
