import type { CreateExpressContextOptions } from '@trpc/server/adapters/express';
import { getAdminAuth } from './firebaseAdmin';

/**
 * Every tRPC request carries only the Firebase UID that the backend verified.
 * Clients never get to choose this value from a request body.
 */
export type TrpcContext = {
  uid: string | null;
  email: string | null;
  adminAccessProof: string;
};

function bearerToken(value: unknown): string {
  const match = String(value || '').match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
}

export async function createContext({ req }: CreateExpressContextOptions): Promise<TrpcContext> {
  const token = bearerToken(req.headers.authorization);
  const adminAccessProof = String(req.headers['x-hy3n-admin-access'] || '');
  if (!token) return { uid: null, email: null, adminAccessProof };

  try {
    // Checking revocation closes the session immediately if Firebase has revoked
    // the account or credential, rather than trusting a still-unexpired token.
    const decoded = await getAdminAuth().verifyIdToken(token, true);
    return {
      uid: decoded.uid,
      email: String(decoded.email || '').trim().toLowerCase() || null,
      adminAccessProof,
    };
  } catch {
    return { uid: null, email: null, adminAccessProof };
  }
}
