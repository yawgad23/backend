import type { Request, Response } from 'express';
import { adminFirestore, getAdminAuth } from './firebaseAdmin';

const OWNER_EMAIL = 'yawgad23@gmail.com';

function bearerToken(request: Request): string {
  const value = String(request.headers.authorization || '');
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
}

async function hasAdministratorAccess(email: string): Promise<boolean> {
  if (email.toLowerCase() === OWNER_EMAIL) return true;
  const normalizedEmail = email.toLowerCase();
  const canonical = await adminFirestore.get('admin_access', normalizedEmail);
  if (canonical?.is_active === true) return true;

  // Older dashboard versions created administrator records with generated
  // document IDs. Recognize those active records during the migration, while
  // all new writes use the canonical email document ID.
  const legacyMatches = await adminFirestore.list('admin_access', { email: normalizedEmail }, null, 'desc', 5);
  return legacyMatches.some((access) => access?.is_active === true);
}

export async function requireAdministrator(request: Request, response: Response): Promise<string | null> {
  const token = bearerToken(request);
  if (!token) {
    response.status(401).json({ error: 'Sign in to continue.' });
    return null;
  }

  try {
    const decoded = await getAdminAuth().verifyIdToken(token);
    const email = String(decoded.email || '').trim().toLowerCase();
    if (!email || !(await hasAdministratorAccess(email))) {
      response.status(403).json({ error: 'Administrator access is required.' });
      return null;
    }
    return email;
  } catch {
    response.status(401).json({ error: 'Your administrator session has expired. Please sign in again.' });
    return null;
  }
}
