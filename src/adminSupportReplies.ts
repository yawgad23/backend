import { createHash } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import { requireAdministrator } from './adminAuthorization';
import { getAdminDb } from './firebaseAdmin';
import { sendSupportEmail, supportEmailConfiguration, SupportEmailError } from './supportEmail';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const replyInput = z.object({ requestId: z.string().uuid(), message: z.string().trim().min(1).max(5000) }).strict();
const email = z.string().trim().max(254).email();
export type SupportReplyState = 'sending' | 'accepted' | 'failed' | 'unknown';
export interface SupportReplyRecord {
  id: string; request_id: string; message: string; created_date: string; author: string;
  recipient: string; sender: string; subject: string; state: SupportReplyState;
  updated_date?: string; provider_message_id?: string;
}
export interface SupportReplyStore {
  history(ticketId: string): Promise<SupportReplyRecord[]>;
  reserve(ticketId: string, actor: string, requestId: string, message: string): Promise<{ reply: SupportReplyRecord; created: boolean }>;
  finish(ticketId: string, reply: SupportReplyRecord, state: Exclude<SupportReplyState, 'sending'>, providerMessageId?: string): Promise<SupportReplyRecord>;
}
export class SupportReplyRequestError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export function supportReplyIdentifier(ticketId: string, actor: string, requestId: string): string {
  return createHash('sha256').update(JSON.stringify([ticketId, actor, requestId])).digest('hex');
}
const firestoreStore: SupportReplyStore = {
  async history(ticketId) {
    const db = getAdminDb();
    const ticket = await db.collection('support_tickets').doc(ticketId).get();
    if (!ticket.exists) throw new SupportReplyRequestError(404, 'This support ticket no longer exists.');
    const result = await ticket.ref.collection('replies').orderBy('created_date', 'desc').limit(100).get();
    return result.docs.map(document => ({ ...document.data(), id: document.id }) as SupportReplyRecord).reverse();
  },
  async reserve(ticketId, actor, requestId, message) {
    const db = getAdminDb();
    const ticketRef = db.collection('support_tickets').doc(ticketId);
    const id = supportReplyIdentifier(ticketId, actor, requestId);
    const replyRef = ticketRef.collection('replies').doc(id);
    return db.runTransaction(async transaction => {
      const [ticket, previous] = await Promise.all([transaction.get(ticketRef), transaction.get(replyRef)]);
      if (!ticket.exists) throw new SupportReplyRequestError(404, 'This support ticket no longer exists.');
      if (previous.exists) {
        const reply = { ...previous.data(), id } as SupportReplyRecord;
        if (reply.message !== message || reply.author !== actor) throw new SupportReplyRequestError(409, 'This send request belongs to a different reply. Refresh the ticket.');
        return { reply, created: false };
      }
      const data = ticket.data()!;
      if (data.support_reply_in_flight) throw new SupportReplyRequestError(409, 'A previous reply is still being checked. Refresh its status before sending another.');
      const parsed = email.safeParse(data.from_email);
      if (!parsed.success) throw new SupportReplyRequestError(400, 'This ticket has no valid reply email address. Update its contact details first.');
      const reply: SupportReplyRecord = {
        id, request_id: requestId, message, created_date: new Date().toISOString(), author: actor,
        recipient: parsed.data, sender: 'HY3N <hello@ridehy3n.com>',
        subject: String(data.subject || 'Your message to HY3N').slice(0, 160), state: 'sending',
      };
      transaction.create(replyRef, reply);
      transaction.update(ticketRef, { support_reply_in_flight: id });
      return { reply, created: true };
    });
  },
  async finish(ticketId, reply, state, providerMessageId) {
    const db = getAdminDb();
    const ticketRef = db.collection('support_tickets').doc(ticketId);
    const replyRef = ticketRef.collection('replies').doc(reply.id);
    const updated: SupportReplyRecord = { ...reply, state, updated_date: new Date().toISOString(), ...(providerMessageId ? { provider_message_id: providerMessageId } : {}) };
    await db.runTransaction(async transaction => {
      const [ticket, current] = await Promise.all([transaction.get(ticketRef), transaction.get(replyRef)]);
      if (!current.exists || current.data()?.state !== 'sending') throw new SupportReplyRequestError(409, 'Reply state changed. Refresh the ticket before continuing.');
      transaction.update(replyRef, updated as unknown as Record<string, unknown>);
      if (ticket.exists && state !== 'unknown' && ticket.data()?.support_reply_in_flight === reply.id) {
        transaction.update(ticketRef, { support_reply_in_flight: null });
      }
      if (state === 'accepted' && ticket.exists) {
        // Keep the existing app-facing field, but never pretend old saved text was emailed.
        const patch: Record<string, unknown> = { admin_reply: reply.message, admin_reply_id: reply.id, admin_reply_at: updated.updated_date };
        if (ticket.data()?.status === 'Open') patch.status = 'In Progress';
        transaction.update(ticketRef, patch);
      }
    });
    return updated;
  },
};
export interface SupportReplyDependencies {
  store: SupportReplyStore;
  configured(): boolean;
  send(input: { to: string; subject: string; message: string; replyId: string }): Promise<{ messageId: string }>;
  authorize(request: Request, response: Response): Promise<string | null>;
}
const defaults: SupportReplyDependencies = {
  store: firestoreStore, configured: () => supportEmailConfiguration().configured,
  send: sendSupportEmail, authorize: requireAdministrator,
};
export async function executeSupportReply(ticketId: string, actor: string, body: unknown, deps: SupportReplyDependencies = defaults) {
  const input = replyInput.safeParse(body);
  if (!identifier.safeParse(ticketId).success || !input.success) throw new SupportReplyRequestError(400, 'Enter a reply of up to 5,000 characters and a valid send request.');
  const reserved = await deps.store.reserve(ticketId, actor, input.data.requestId, input.data.message);
  // Any existing terminal/active record is replayed, never emailed a second time.
  if (!reserved.created) return { reply: reserved.reply, duplicate: true };
  const reply = reserved.reply;
  if (!deps.configured()) {
    const failed = await deps.store.finish(ticketId, reply, 'failed');
    return { reply: failed, duplicate: false };
  }
  let result: { messageId: string };
  try {
    result = await deps.send({ to: reply.recipient, subject: reply.subject, message: reply.message, replyId: reply.id });
  } catch (error) {
    const state = error instanceof SupportEmailError ? error.delivery : 'unknown';
    return { reply: await deps.store.finish(ticketId, reply, state), duplicate: false };
  }
  // If SMTP succeeds but persistence fails, the record stays sending: no blind resend.
  return { reply: await deps.store.finish(ticketId, reply, 'accepted', result.messageId), duplicate: false };
}
export function registerAdminSupportReplyRoutes(app: Express, dependencies: SupportReplyDependencies = defaults) {
  app.get('/api/admin/support/:ticketId/replies', async (request: Request, response: Response) => {
    const administrator = await dependencies.authorize(request, response);
    if (!administrator) return;
    response.setHeader('Cache-Control', 'no-store');
    const ticketId = String(request.params.ticketId || '');
    if (!identifier.safeParse(ticketId).success) { response.status(400).json({ error: 'Invalid support ticket.' }); return; }
    try {
      const replies = await dependencies.store.history(ticketId);
      response.json({ replies, emailConfigured: dependencies.configured(), sender: 'HY3N <hello@ridehy3n.com>' });
    } catch (error) {
      response.status(error instanceof SupportReplyRequestError ? error.status : 503).json({ error: error instanceof SupportReplyRequestError ? error.message : 'Reply history is temporarily unavailable. Please retry.' });
    }
  });
  app.post('/api/admin/support/:ticketId/replies', async (request: Request, response: Response) => {
    const administrator = await dependencies.authorize(request, response);
    if (!administrator) return;
    response.setHeader('Cache-Control', 'no-store');
    try {
      const result = await executeSupportReply(String(request.params.ticketId || ''), administrator, request.body, dependencies);
      const state = result.reply.state;
      const status = state === 'accepted' ? 200 : state === 'failed' ? 502 : 202;
      response.status(status).json({ ...result, ...(state === 'failed' ? { error: 'Support email was not sent. Your draft is retained. Check the support mailbox configuration before retrying.' } : {}) });
    } catch (error) {
      response.status(error instanceof SupportReplyRequestError ? error.status : 503).json({ error: error instanceof SupportReplyRequestError ? error.message : 'Sending could not be confirmed. Refresh this ticket before trying again.' });
    }
  });
}
