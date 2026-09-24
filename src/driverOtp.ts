import crypto from 'crypto';
import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import { adminFirestore, ADMIN_COLLECTIONS, getAdminAuth } from './firebaseAdmin';

const OTP_COLLECTION = 'otp_verifications';
const OTP_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const SEND_WINDOW_MS = 60 * 60 * 1000;
const MAX_SENDS_PER_WINDOW = 5;
const MAX_VERIFY_ATTEMPTS = 5;

const sendOtpInput = z.object({
  phoneNumber: z.string().min(9).max(24),
});

const verifyOtpInput = z.object({
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit verification code.'),
});

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    crypto.timingSafeEqual(leftBuffer, leftBuffer);
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function normalizeGhanaPhone(phoneInput: string): string | null {
  const digits = String(phoneInput || '').replace(/\D/g, '');
  const local = digits.startsWith('233') ? `0${digits.slice(3)}` : digits;
  if (!/^0\d{9}$/.test(local)) return null;
  return `+233${local.slice(1)}`;
}

function otpHash(driverId: string, code: string): string {
  const pepper = process.env.HUBTEL_OTP_PEPPER || '';
  if (!pepper) throw new Error('SMS verification is temporarily unavailable. Please contact support.');
  return crypto.createHash('sha256').update(`${driverId}:${code}:${pepper}`).digest('hex');
}

function asMilliseconds(value: unknown): number {
  const milliseconds = new Date(String(value || '')).getTime();
  return Number.isFinite(milliseconds) ? milliseconds : 0;
}

function messageFromProvider(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const record = payload as Record<string, unknown>;
  return String(record.Message ?? record.message ?? record.Description ?? record.description ?? record.Status ?? record.status ?? '');
}

function providerRejected(response: { ok: boolean }, payload: unknown): boolean {
  if (!response.ok) return true;
  const message = messageFromProvider(payload).toLowerCase();
  return /\b(error|failed|failure|invalid|insufficient|denied|unauthori[sz]ed)\b/.test(message);
}

async function authenticatedDriverId(req: Request, res: Response): Promise<string | null> {
  const authorization = String(req.headers.authorization || '');
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    res.status(401).json({ success: false, message: 'Please sign in before verifying your phone number.' });
    return null;
  }

  try {
    return (await getAdminAuth().verifyIdToken(match[1])).uid;
  } catch {
    res.status(401).json({ success: false, message: 'Your session has expired. Please sign in again.' });
    return null;
  }
}

async function persistVerifiedDriverPhone(driverId: string, phoneNumber: string) {
  const patch = {
    momo_number: phoneNumber,
    momo_phone_verified: true,
    momo_phone_verified_at: new Date().toISOString(),
    momo_phone_verification_provider: 'hubtel_sms',
  };
  const profiles = await adminFirestore.list(ADMIN_COLLECTIONS.DRIVER_PROFILES, { user_id: driverId }, null, 'desc', 10);
  const canonical = await adminFirestore.get(ADMIN_COLLECTIONS.DRIVER_PROFILES, driverId);
  const uniqueProfiles = [...profiles, canonical].filter((item): item is Record<string, any> => Boolean(item))
    .filter((item, index, list) => list.findIndex((other) => other.id === item.id) === index);

  if (uniqueProfiles.length === 0) {
    await adminFirestore.set(ADMIN_COLLECTIONS.DRIVER_PROFILES, driverId, { user_id: driverId, ...patch });
    return;
  }

  await Promise.all(uniqueProfiles.map((profile) => adminFirestore.update(ADMIN_COLLECTIONS.DRIVER_PROFILES, profile.id, patch)));
}

/**
 * Driver MoMo-number verification using Hubtel's Programmable SMS gateway.
 * Credentials live only in Firebase Secret Manager. These routes intentionally
 * use a Firebase ID token, so one Driver cannot request codes for another
 * profile or verify a code against someone else's account.
 */
export function registerDriverOtpRoutes(app: Express) {
  app.post('/api/driver/otp/send', async (req, res) => {
    const driverId = await authenticatedDriverId(req, res);
    if (!driverId) return;

    const parsed = sendOtpInput.safeParse(req.body);
    const phoneNumber = parsed.success ? normalizeGhanaPhone(parsed.data.phoneNumber) : null;
    if (!phoneNumber) {
      res.status(400).json({ success: false, message: 'Enter a valid Ghana mobile number.' });
      return;
    }

    const clientId = String(process.env.HUBTEL_SMS_CLIENT_ID || '').trim();
    const clientSecret = String(process.env.HUBTEL_SMS_CLIENT_SECRET || '').trim();
    const senderId = String(process.env.HUBTEL_SMS_SENDER_ID || 'Hy3n').trim();
    if (!clientId || !clientSecret || !process.env.HUBTEL_OTP_PEPPER) {
      console.error('[Hubtel SMS] Driver OTP requested but SMS secrets are not configured.');
      res.status(503).json({ success: false, message: 'SMS verification is temporarily unavailable. Please contact support.' });
      return;
    }

    const now = Date.now();
    const existing = await adminFirestore.get(OTP_COLLECTION, driverId);
    const lastSentAt = asMilliseconds(existing?.last_sent_at);
    const windowStartedAt = asMilliseconds(existing?.send_window_started_at);
    const inCurrentWindow = windowStartedAt > 0 && now - windowStartedAt < SEND_WINDOW_MS;
    const sendsInWindow = inCurrentWindow ? Number(existing?.send_count_in_window || 0) : 0;
    if (lastSentAt > 0 && now - lastSentAt < RESEND_COOLDOWN_MS) {
      res.status(429).json({ success: false, message: 'Please wait one minute before requesting another code.' });
      return;
    }
    if (sendsInWindow >= MAX_SENDS_PER_WINDOW) {
      res.status(429).json({ success: false, message: 'Too many verification codes were requested. Please try again in one hour.' });
      return;
    }

    const code = crypto.randomInt(100000, 1_000_000).toString();
    const expiresAt = new Date(now + OTP_TTL_MS).toISOString();
    const query = new URLSearchParams({
      clientsecret: clientSecret,
      clientid: clientId,
      from: senderId,
      to: phoneNumber,
      content: `Your HY3N verification code is ${code}. It expires in 10 minutes. Do not share this code.`,
    });

    let providerPayload: unknown = null;
    try {
      // This is the exact Programmable SMS endpoint shape displayed in the
      // account portal for this key. It is called only from the backend.
      const providerResponse = await fetch(`https://sms.hubtel.com/v1/messages/send?${query.toString()}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      const raw = await providerResponse.text();
      try { providerPayload = raw ? JSON.parse(raw) : {}; } catch { providerPayload = { message: raw.slice(0, 300) }; }
      if (providerRejected(providerResponse, providerPayload)) {
        console.error('[Hubtel SMS] Driver OTP delivery rejected.', { status: providerResponse.status, providerMessage: messageFromProvider(providerPayload) });
        res.status(502).json({ success: false, message: 'We could not send the verification SMS. Please check your number and try again.' });
        return;
      }
    } catch (error: any) {
      console.error('[Hubtel SMS] Driver OTP delivery request failed.', { message: String(error?.message || 'network error') });
      res.status(502).json({ success: false, message: 'We could not send the verification SMS. Please try again shortly.' });
      return;
    }

    await adminFirestore.set(OTP_COLLECTION, driverId, {
      driver_id: driverId,
      phone_number: phoneNumber,
      code_hash: otpHash(driverId, code),
      expires_at: expiresAt,
      verified: false,
      last_sent_at: new Date(now).toISOString(),
      send_window_started_at: inCurrentWindow ? new Date(windowStartedAt).toISOString() : new Date(now).toISOString(),
      send_count_in_window: sendsInWindow + 1,
      verification_attempts: 0,
      provider: 'hubtel_sms',
    });

    res.json({ success: true, message: 'Verification code sent.', phoneNumber, expiresAt });
  });

  app.post('/api/driver/otp/verify', async (req, res) => {
    const driverId = await authenticatedDriverId(req, res);
    if (!driverId) return;

    const parsed = verifyOtpInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, message: 'Enter the 6-digit verification code.' });
      return;
    }

    const record = await adminFirestore.get(OTP_COLLECTION, driverId);
    if (!record || !record.code_hash || !record.phone_number) {
      res.status(400).json({ success: false, message: 'Request a new verification code first.' });
      return;
    }
    if (asMilliseconds(record.expires_at) <= Date.now()) {
      await adminFirestore.delete(OTP_COLLECTION, driverId);
      res.status(400).json({ success: false, message: 'That verification code has expired. Request a new one.' });
      return;
    }

    const attempts = Number(record.verification_attempts || 0);
    if (attempts >= MAX_VERIFY_ATTEMPTS) {
      await adminFirestore.delete(OTP_COLLECTION, driverId);
      res.status(429).json({ success: false, message: 'Too many incorrect attempts. Request a new verification code.' });
      return;
    }

    let expectedHash = '';
    try {
      expectedHash = otpHash(driverId, parsed.data.code);
    } catch (error: any) {
      console.error('[Hubtel SMS] OTP verification unavailable.', { message: String(error?.message || '') });
      res.status(503).json({ success: false, message: 'SMS verification is temporarily unavailable. Please contact support.' });
      return;
    }
    if (!safeEqual(String(record.code_hash), expectedHash)) {
      await adminFirestore.update(OTP_COLLECTION, driverId, { verification_attempts: attempts + 1 });
      res.status(400).json({ success: false, message: 'That verification code is not correct. Please try again.' });
      return;
    }

    await persistVerifiedDriverPhone(driverId, String(record.phone_number));
    await adminFirestore.delete(OTP_COLLECTION, driverId);
    res.json({ success: true, message: 'Phone number verified.', phoneNumber: record.phone_number });
  });
}
