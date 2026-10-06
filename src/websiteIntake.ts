import { createHash } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import { adminFirestore, ADMIN_COLLECTIONS, getAdminDb } from './firebaseAdmin';

const INTAKE_RATE_LIMIT_COLLECTION = 'website_intake_rate_limits';
const INTAKE_WINDOW_MS = 15 * 60 * 1000;
const INTAKE_MAX_REQUESTS_PER_WINDOW = 8;
const INTAKE_RATE_LIMIT_RETENTION_MS = 24 * 60 * 60 * 1000;

const applicationKinds = ['driver-signup', 'car', 'bike'] as const;
const intakeKinds = ['contact', ...applicationKinds] as const;

type IntakeKind = typeof intakeKinds[number];
type IntakeRateLimitRecord = { attempts?: unknown };

const textField = (max: number) => z.string().trim().max(max).optional().default('');

export const websiteIntakeInput = z.object({
  kind: z.enum(intakeKinds),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: z.string().trim().max(254).optional().default(''),
  phone: textField(40),
  city: textField(120),
  userType: textField(40),
  subject: textField(100),
  vehicleType: textField(100),
  ownsVehicle: textField(100),
  hasLicence: textField(100),
  intendedUse: textField(100),
  hearAbout: textField(100),
  message: textField(2_000),
  // This field remains visually hidden in the website forms. Bots that fill it
  // receive a neutral acknowledgement, while no personal record is created.
  website: z.string().max(200).optional().default(''),
}).superRefine((value, context) => {
  const isContact = value.kind === 'contact';
  if (isContact && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)) {
    context.addIssue({ code: 'custom', path: ['email'], message: 'Enter a valid email address.' });
  }
  if (!isContact && value.phone.trim().length < 7) {
    context.addIssue({ code: 'custom', path: ['phone'], message: 'Enter a valid phone number.' });
  }
  if (!isContact && !value.city) {
    context.addIssue({ code: 'custom', path: ['city'], message: 'Enter a city or location.' });
  }
  if (isContact && !value.message) {
    context.addIssue({ code: 'custom', path: ['message'], message: 'Enter a message.' });
  }
});

export type WebsiteIntake = z.infer<typeof websiteIntakeInput>;

function recentAttempts(value: unknown, nowMs: number): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > nowMs - INTAKE_WINDOW_MS && item <= nowMs)
    .slice(-50);
}

export function websiteIntakeRateKey(ip: string): string {
  const digest = createHash('sha256').update(String(ip || 'unknown')).digest('base64url');
  return `ip_${digest}`;
}

export function allowsWebsiteIntake(attempts: unknown, nowMs: number): boolean {
  return recentAttempts(attempts, nowMs).length < INTAKE_MAX_REQUESTS_PER_WINDOW;
}

function requesterIp(request: Request): string {
  // Express is configured with one trusted Cloud Run proxy in app.ts. The raw
  // address is hashed before persistence and is never stored with the intake.
  return String(request.ip || request.socket.remoteAddress || 'unknown').slice(0, 128);
}

async function claimWebsiteIntakeRateLimit(ip: string): Promise<boolean> {
  const nowMs = Date.now();
  const db = getAdminDb();
  const reference = db.collection(INTAKE_RATE_LIMIT_COLLECTION).doc(websiteIntakeRateKey(ip));

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const attempts = recentAttempts((snapshot.data() as IntakeRateLimitRecord | undefined)?.attempts, nowMs);
    if (!allowsWebsiteIntake(attempts, nowMs)) return false;

    transaction.set(reference, {
      attempts: [...attempts, nowMs],
      expires_at: new Date(nowMs + INTAKE_RATE_LIMIT_RETENTION_MS),
      updated_at: new Date(nowMs).toISOString(),
    });
    return true;
  });
}

const kindLabels: Record<IntakeKind, string> = {
  contact: 'Website contact message',
  'driver-signup': 'Website Driver application',
  car: 'Website Car Work & Pay application',
  bike: 'Website Motorbike Work & Pay application',
};

function contactSubject(value: WebsiteIntake): string {
  const topic = value.subject.replace(/[_-]+/g, ' ').trim();
  return topic ? `Website contact — ${topic}` : kindLabels.contact;
}

function applicationMessage(value: WebsiteIntake): string {
  const fields: Array<[string, string]> = [
    ['Application', kindLabels[value.kind]],
    ['Location', value.city],
    ['Phone', value.phone],
    ['Email', value.email],
    ['Vehicle type', value.vehicleType],
    ['Vehicle ownership', value.ownsVehicle],
    ['Licence', value.hasLicence],
    ['Intended use', value.intendedUse],
    ['How they heard about HY3N', value.hearAbout],
    ['Additional message', value.message],
  ];
  return fields
    .filter(([, fieldValue]) => Boolean(fieldValue))
    .map(([label, fieldValue]) => `${label}: ${fieldValue}`)
    .join('\n');
}

export function websiteIntakeTicket(value: WebsiteIntake): Record<string, unknown> {
  const fullName = `${value.firstName} ${value.lastName}`.trim();
  const isContact = value.kind === 'contact';
  const complaint = value.subject.trim().toLowerCase() === 'complaint';

  return {
    source: 'website',
    source_form: value.kind,
    application_type: isContact ? null : value.kind,
    user_type: 'website_visitor',
    from_name: fullName,
    from_email: value.email || null,
    from_phone: value.phone || null,
    subject: isContact ? contactSubject(value) : kindLabels[value.kind],
    category: isContact ? (complaint ? 'complaint' : 'website_contact') : 'website_application',
    priority: complaint ? 'High' : 'Medium',
    status: 'Open',
    message: isContact ? value.message : applicationMessage(value),
    website_intake: {
      city: value.city || null,
      vehicle_type: value.vehicleType || null,
      owns_vehicle: value.ownsVehicle || null,
      has_licence: value.hasLicence || null,
      intended_use: value.intendedUse || null,
      heard_about: value.hearAbout || null,
      user_type: value.userType || null,
    },
  };
}

export function registerWebsiteIntakeRoutes(app: Express, isTrustedOrigin: (origin: string) => boolean) {
  app.post('/api/website/intake', async (request: Request, response: Response) => {
    const origin = String(request.headers.origin || '');
    if (!origin || !isTrustedOrigin(origin)) {
      response.status(403).json({ success: false, message: 'This form can only be submitted from the HY3N website.' });
      return;
    }

    const parsed = websiteIntakeInput.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ success: false, message: 'Please complete the required fields and try again.' });
      return;
    }

    const input = parsed.data;
    // Do not reveal bot filtering decisions. A filled honeypot looks successful
    // to the sender but creates no record and cannot generate staff noise.
    if (input.website.trim()) {
      response.status(201).json({ success: true, message: 'Your message has been received.' });
      return;
    }

    let permitted = false;
    try {
      permitted = await claimWebsiteIntakeRateLimit(requesterIp(request));
    } catch (error) {
      console.error('[Website intake] Rate-limit storage failed:', error);
      response.status(503).json({ success: false, message: 'The form is temporarily unavailable. Please try again shortly.' });
      return;
    }
    if (!permitted) {
      response.status(429).json({ success: false, message: 'Please wait a few minutes before sending another form.' });
      return;
    }

    try {
      const ticket = await adminFirestore.create(ADMIN_COLLECTIONS.SUPPORT_TICKETS, websiteIntakeTicket(input));
      response.status(201).json({ success: true, message: 'Your message has been received.', submissionId: ticket.id });
    } catch (error) {
      // Never log form data because it may contain contact information.
      console.error('[Website intake] Ticket creation failed:', error);
      response.status(503).json({ success: false, message: 'The form is temporarily unavailable. Please try again shortly.' });
    }
  });
}
