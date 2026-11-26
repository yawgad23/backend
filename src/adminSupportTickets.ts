import type { Express, Request, Response } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { requireAdministrator } from './adminAuthorization';
import { getAdminDb } from './firebaseAdmin';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const contactEmail = z.string().trim().max(254).refine(value => value === '' || z.string().email().safeParse(value).success);
// Do not accept provenance, account associations, reply fields or timestamps.
const metadataInput = z.object({
  subject: z.string().trim().min(1).max(160),
  message: z.string().trim().min(1).max(10_000),
  from_name: z.string().trim().min(1).max(160),
  from_email: contactEmail.optional(),
  from_phone: z.string().trim().max(40).optional(),
  category: z.string().trim().max(100).optional(),
  priority: z.enum(['Low', 'Medium', 'High', 'Urgent']).optional(),
  status: z.enum(['Open', 'In Progress', 'Resolved', 'Closed']).optional(),
  related_ride_id: z.string().trim().max(160).optional(),
}).strict();
const patchInput = metadataInput.partial().refine(value => Object.keys(value).length > 0);
export type SupportTicketMetadata = z.infer<typeof metadataInput>;
export type SupportTicketPatch = Partial<SupportTicketMetadata>;
export type SupportTicket = Record<string, unknown> & { id: string };
export interface SupportTicketStore {
  list(): Promise<SupportTicket[]>;
  create(input: SupportTicketMetadata): Promise<SupportTicket>;
  patch(ticketId: string, input: SupportTicketPatch): Promise<SupportTicket>;
  archive(ticketId: string): Promise<void>;
}
export class SupportTicketRequestError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

const timestampFields = new Set(['created_date', 'updated_date', 'resolved_at', 'archived_at', 'admin_reply_at']);
function isoDate(value: unknown): string | null {
  const date = value instanceof Date ? value : new Date(value as string | number);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
/** Normalize native and serialized Firestore timestamps, including nested audit data. */
function normalizeValue(value: unknown, field = ''): unknown {
  if (value == null) return value;
  if (value instanceof Date) return isoDate(value);
  if (typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    if (typeof object.toDate === 'function') return isoDate((object.toDate as () => Date)());
    const seconds = object.seconds ?? object._seconds;
    const nanos = object.nanoseconds ?? object._nanoseconds ?? 0;
    if (typeof seconds === 'number' && typeof nanos === 'number') return isoDate(seconds * 1000 + nanos / 1_000_000);
    return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, normalizeValue(item, key)]));
  }
  if (Array.isArray(value)) return value.map(item => normalizeValue(item));
  if (timestampFields.has(field) && (typeof value === 'string' || typeof value === 'number')) return isoDate(value);
  return value;
}
export function normalizeSupportTicket(data: Record<string, unknown>, id: string): SupportTicket {
  return { ...(normalizeValue(data) as Record<string, unknown>), id };
}
function parseCreate(input: unknown): SupportTicketMetadata {
  const parsed = metadataInput.safeParse(input);
  if (!parsed.success) throw new SupportTicketRequestError(400, 'Enter valid support ticket details using only editable metadata fields.');
  return parsed.data;
}
function parsePatch(input: unknown): SupportTicketPatch {
  const parsed = patchInput.safeParse(input);
  if (!parsed.success) throw new SupportTicketRequestError(400, 'Provide at least one valid editable support ticket field.');
  return parsed.data;
}
function validateIdentifier(ticketId: string) {
  if (!identifier.safeParse(ticketId).success) throw new SupportTicketRequestError(400, 'Invalid support ticket.');
}
function requireEditable(data: Record<string, unknown> | undefined) {
  if (!data || data.archived === true) throw new SupportTicketRequestError(404, 'This support ticket no longer exists.');
  if (data.support_reply_in_flight) throw new SupportTicketRequestError(409, 'A reply is still being checked. Refresh its status before changing this ticket.');
}
function isResolved(status: unknown) { return status === 'Resolved' || status === 'Closed'; }

/** Kept injectable so offline tests exercise the actual query and transactions. */
export function createFirestoreSupportTicketStore(
  database: () => Firestore = getAdminDb,
  now: () => string = () => new Date().toISOString(),
): SupportTicketStore {
  return {
    async list() {
      const result = await database().collection('support_tickets').orderBy('created_date', 'desc').limit(200).get();
      return result.docs.filter(document => document.data().archived !== true)
        .map(document => normalizeSupportTicket(document.data(), document.id))
        .sort((a, b) => String(b.created_date || '').localeCompare(String(a.created_date || '')));
    },
    async create(input) {
      const metadata = parseCreate(input);
      const timestamp = now();
      const payload = {
        from_email: '', from_phone: '', category: 'general', priority: 'Medium', status: 'Open', related_ride_id: '',
        ...metadata, source: 'admin', user_type: 'admin_created',
        created_date: timestamp, updated_date: timestamp,
        resolved_at: isResolved(metadata.status) ? timestamp : null,
      };
      const reference = await database().collection('support_tickets').add(payload);
      return normalizeSupportTicket(payload, reference.id);
    },
    async patch(ticketId, input) {
      validateIdentifier(ticketId);
      const metadata = parsePatch(input);
      const db = database();
      const reference = db.collection('support_tickets').doc(ticketId);
      return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(reference);
        const data = snapshot.exists ? snapshot.data() : undefined;
        requireEditable(data);
        const timestamp = now();
        const patch: Record<string, unknown> = { ...metadata, updated_date: timestamp };
        if (metadata.status !== undefined) {
          patch.resolved_at = isResolved(metadata.status)
            ? (isResolved(data!.status) && data!.resolved_at ? data!.resolved_at : timestamp)
            : null;
        }
        // A narrow update preserves provenance, user association, legacy replies
        // and the nested replies collection. The lock check shares the transaction.
        transaction.update(reference, patch);
        return normalizeSupportTicket({ ...data, ...patch }, snapshot.id);
      });
    },
    async archive(ticketId) {
      validateIdentifier(ticketId);
      const db = database();
      const reference = db.collection('support_tickets').doc(ticketId);
      await db.runTransaction(async transaction => {
        const snapshot = await transaction.get(reference);
        requireEditable(snapshot.exists ? snapshot.data() : undefined);
        const timestamp = now();
        // Never hard-delete the document or its reply audit subcollection.
        transaction.update(reference, { archived: true, archived_at: timestamp, updated_date: timestamp });
      });
    },
  };
}
export interface SupportTicketDependencies {
  store: SupportTicketStore;
  authorize(request: Request, response: Response): Promise<string | null>;
}
const defaults: SupportTicketDependencies = { store: createFirestoreSupportTicketStore(), authorize: requireAdministrator };

export function registerAdminSupportTicketRoutes(app: Express, dependencies: SupportTicketDependencies = defaults) {
  function handler(operation: (request: Request, response: Response) => Promise<void>) {
    return async (request: Request, response: Response) => {
      response.setHeader('Cache-Control', 'no-store');
      try {
        if (!(await dependencies.authorize(request, response))) return;
        await operation(request, response);
      } catch (error) {
        response.status(error instanceof SupportTicketRequestError ? error.status : 503).json({
          error: error instanceof SupportTicketRequestError ? error.message : 'Support tickets are temporarily unavailable. Please retry.',
        });
      }
    };
  }
  app.get('/api/admin/support', handler(async (_request, response) => {
    const tickets = await dependencies.store.list();
    response.json({ tickets: tickets.filter(ticket => ticket.archived !== true).map(ticket => normalizeSupportTicket(ticket, ticket.id)) });
  }));
  app.post('/api/admin/support', handler(async (request, response) => {
    const ticket = await dependencies.store.create(parseCreate(request.body));
    response.status(201).json({ ticket: normalizeSupportTicket(ticket, ticket.id) });
  }));
  app.patch('/api/admin/support/:ticketId', handler(async (request, response) => {
    const ticketId = String(request.params.ticketId || '');
    validateIdentifier(ticketId);
    const ticket = await dependencies.store.patch(ticketId, parsePatch(request.body));
    response.json({ ticket: normalizeSupportTicket(ticket, ticket.id) });
  }));
  app.delete('/api/admin/support/:ticketId', handler(async (request, response) => {
    const ticketId = String(request.params.ticketId || '');
    validateIdentifier(ticketId);
    await dependencies.store.archive(ticketId);
    response.json({ deleted: true });
  }));
}
