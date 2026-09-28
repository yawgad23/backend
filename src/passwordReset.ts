import { createHash } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { ADMIN_COLLECTIONS, getAdminAuth, getAdminDb } from './firebaseAdmin';
import { sendPasswordResetEmail } from './email';

const GENERIC_RESET_MESSAGE = 'If an account exists for this email, we have sent a reset link.';
const EMAIL_WINDOW_MS = 60 * 60 * 1000;
const EMAIL_COOLDOWN_MS = 60 * 1000;
const EMAIL_MAX_REQUESTS_PER_WINDOW = 3;
const IP_WINDOW_MS = 15 * 60 * 1000;
const IP_MAX_REQUESTS_PER_WINDOW = 10;
const RECORD_RETENTION_MS = 24 * 60 * 60 * 1000;

type RateLimitRecord = {
  attempts?: unknown;
};

export function normalizeResetEmail(value: unknown): string | null {
  const email = String(value || '').trim().toLowerCase();
  if (!email || email.length > 254) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

export function passwordResetRateKey(scope: 'email' | 'ip', rawValue: string): string {
  const hash = createHash('sha256').update(rawValue).digest('base64url');
  return `${scope}_${hash}`;
}

function recentAttempts(value: unknown, nowMs: number, windowMs: number): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > nowMs - windowMs && item <= nowMs)
    .slice(-50);
}

export function allowsPasswordResetRequest(
  emailAttempts: unknown,
  ipAttempts: unknown,
  nowMs: number,
): boolean {
  const recentEmailAttempts = recentAttempts(emailAttempts, nowMs, EMAIL_WINDOW_MS);
  const recentIpAttempts = recentAttempts(ipAttempts, nowMs, IP_WINDOW_MS);
  const mostRecentEmailAttempt = recentEmailAttempts.at(-1) || 0;

  return recentEmailAttempts.length < EMAIL_MAX_REQUESTS_PER_WINDOW
    && recentIpAttempts.length < IP_MAX_REQUESTS_PER_WINDOW
    && nowMs - mostRecentEmailAttempt >= EMAIL_COOLDOWN_MS;
}

function requestIp(req: Request): string {
  // Express receives the right-most address after the one trusted Cloud Run proxy.
  // Keep only a bounded, non-identifying token in Firestore by hashing it below.
  return String(req.ip || req.socket.remoteAddress || 'unknown').slice(0, 128);
}

async function claimPasswordResetRateLimit(email: string | null, ip: string): Promise<boolean> {
  const db = getAdminDb();
  const nowMs = Date.now();
  const ipRef = db.collection(ADMIN_COLLECTIONS.PASSWORD_RESET_LIMITS).doc(passwordResetRateKey('ip', ip));
  const emailRef = email
    ? db.collection(ADMIN_COLLECTIONS.PASSWORD_RESET_LIMITS).doc(passwordResetRateKey('email', email))
    : null;

  return db.runTransaction(async (transaction) => {
    const [ipSnapshot, emailSnapshot] = await Promise.all([
      transaction.get(ipRef),
      emailRef ? transaction.get(emailRef) : Promise.resolve(null),
    ]);
    const ipAttempts = recentAttempts((ipSnapshot.data() as RateLimitRecord | undefined)?.attempts, nowMs, IP_WINDOW_MS);
    const emailAttempts = emailRef
      ? recentAttempts((emailSnapshot?.data() as RateLimitRecord | undefined)?.attempts, nowMs, EMAIL_WINDOW_MS)
      : [];

    if (!allowsPasswordResetRequest(emailAttempts, ipAttempts, nowMs)) return false;

    const expiresAt = new Date(nowMs + RECORD_RETENTION_MS);
    transaction.set(ipRef, {
      attempts: [...ipAttempts, nowMs],
      expires_at: expiresAt,
      updated_at: new Date(nowMs).toISOString(),
    });
    if (emailRef) {
      transaction.set(emailRef, {
        attempts: [...emailAttempts, nowMs],
        expires_at: expiresAt,
        updated_at: new Date(nowMs).toISOString(),
      });
    }
    return true;
  });
}

async function deliverResetEmailIfEligible(email: string): Promise<void> {
  try {
    const auth = getAdminAuth();
    const user = await auth.getUserByEmail(email);
    if (user.disabled) return;

    const link = await auth.generatePasswordResetLink(email);
    const sent = await sendPasswordResetEmail(email, link);
    if (!sent) console.error('[Password reset] Email delivery failed after a permitted request.');
  } catch {
    // The external response remains identical whether the account is unknown,
    // disabled, or email delivery is unavailable. Never log the submitted email.
    console.info('[Password reset] No reset message was delivered for a permitted request.');
  }
}

export function registerPasswordResetRoutes(app: Express) {
  app.post('/api/auth/password-reset', async (req: Request, res: Response) => {
    const email = normalizeResetEmail(req.body?.email);
    const permitted = await claimPasswordResetRateLimit(email, requestIp(req)).catch((error) => {
      console.error('[Password reset] Rate-limit storage failed:', error);
      return false;
    });

    // Invalid requests, unknown accounts, disabled accounts, rate limits, and
    // SMTP failures intentionally share the same response to prevent account
    // enumeration. The endpoint accepts no user ID and derives no ownership
    // from client-controlled identity fields.
    if (permitted && email) await deliverResetEmailIfEligible(email);
    res.status(200).json({ success: true, message: GENERIC_RESET_MESSAGE });
  });
}
