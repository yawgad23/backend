import { Express } from "express";
/**
 * Builds the Express app. Shared by src/index.ts (local dev / a plain Node
 * server) and src/functions.ts (Firebase Cloud Functions) so the actual
 * routes/middleware are defined in exactly one place.
 */
export declare function createApp(): Express;
