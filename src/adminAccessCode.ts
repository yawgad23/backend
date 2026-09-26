import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import { getAdminAuth } from './firebaseAdmin';
import { requireAdministratorIdentity } from './adminAuthorization';

const ACCESS_CODE_HEADER = 'x-hy3n-admin-access';
const ACCESS_CODE_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

type FailedAttempt = { count: number; resetAt: number };
const failedAttempts = new Map<string, FailedAttempt>();

function configuredAccessCode(): string {
  return String(process.env.ADMIN_DASHBOARD_PIN || '').trim();
}

function requestKey(request: Request, email: string): string {
  const forwarded = request.headers['x-forwarded-for'];
  const clientAddress = Array.isArray(forwarded)
    ? forwarded[0]
    : String(forwarded || request.socket.remoteAddress || 'unknown').split(',')[0].trim();
  return `${email}:${clientAddress}`;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function createAdministratorAccessProof(email: string, accessCode: string, expiresAt: number): string {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const payload = `${normalizedEmail}:${expiresAt}:${randomBytes(12).toString('base64url')}`;
  const signature = createHmac('sha256', accessCode).update(payload).digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${signature}`;
}

export function verifyAdministratorAccessProof(email: string, accessCode: string, proof: string, now = Date.now()): boolean {
  const [encodedPayload, suppliedSignature, ...extra] = String(proof || '').split('.');
  if (!encodedPayload || !suppliedSignature || extra.length > 0) return false;

  let payload = '';
  try {
    payload = Buffer.from(encodedPayload, 'base64url').toString('utf8');
  } catch {
    return false;
  }

  const [proofEmail, expiresAtText, nonce, ...payloadExtra] = payload.split(':');
  const expiresAt = Number(expiresAtText);
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (
    payloadExtra.length > 0 ||
    !proofEmail ||
    !nonce ||
    proofEmail !== normalizedEmail ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now
  ) {
    return false;
  }

  const expectedSignature = createHmac('sha256', accessCode).update(payload).digest('base64url');
  return safeEqual(suppliedSignature, expectedSignature);
}

function failedAttemptState(key: string, now = Date.now()): FailedAttempt {
  const current = failedAttempts.get(key);
  if (!current || current.resetAt <= now) {
    const fresh = { count: 0, resetAt: now + ATTEMPT_WINDOW_MS };
    failedAttempts.set(key, fresh);
    return fresh;
  }
  return current;
}

export async function hasAdministratorAccessCode(request: Request, email: string): Promise<boolean> {
  const accessCode = configuredAccessCode();
  if (!accessCode) return false;
  return verifyAdministratorAccessProof(email, accessCode, String(request.headers[ACCESS_CODE_HEADER] || ''));
}

export async function requireAdministratorAccessCode(request: Request, response: Response, email: string): Promise<boolean> {
  if (await hasAdministratorAccessCode(request, email)) return true;
  response.status(401).json({
    error: 'Enter the administrator access code to continue.',
    code: 'ADMIN_ACCESS_CODE_REQUIRED',
  });
  return false;
}

/**
 * A code is deliberately a second factor, never a substitute for Firebase
 * authentication or the server-side admin_access authorization record.
 */
export function registerAdminAccessCodeRoutes(app: import('express').Express) {
  app.get('/api/admin/session', async (request: Request, response: Response) => {
    const email = await requireAdministratorIdentity(request, response);
    if (!email) return;
    response.json({
      administrator: email,
      accessCodeRequired: true,
      accessGranted: await hasAdministratorAccessCode(request, email),
    });
  });

  app.post('/api/admin/access-code/verify', async (request: Request, response: Response) => {
    const email = await requireAdministratorIdentity(request, response);
    if (!email) return;

    const accessCode = configuredAccessCode();
    if (!accessCode) {
      console.error('[Admin access code] ADMIN_DASHBOARD_PIN is not configured');
      response.status(503).json({ error: 'Administrator access-code verification is not configured.' });
      return;
    }

    const key = requestKey(request, email);
    const attempts = failedAttemptState(key);
    const now = Date.now();
    if (attempts.count >= MAX_FAILED_ATTEMPTS) {
      response.status(429).json({
        error: `Too many incorrect attempts. Try again in ${Math.max(1, Math.ceil((attempts.resetAt - now) / 60000))} minutes.`,
      });
      return;
    }

    const submittedCode = String(request.body?.accessCode || '').trim();
    if (!submittedCode || !safeEqual(submittedCode, accessCode)) {
      attempts.count += 1;
      response.status(401).json({ error: 'Incorrect administrator access code.' });
      return;
    }

    failedAttempts.delete(key);
    const expiresAt = now + ACCESS_CODE_TTL_MS;
    response.json({
      accessProof: createAdministratorAccessProof(email, accessCode, expiresAt),
      expiresAt: new Date(expiresAt).toISOString(),
    });
  });
}
