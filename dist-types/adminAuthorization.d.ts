import type { Request, Response } from 'express';
export declare function requireAdministrator(request: Request, response: Response): Promise<string | null>;
