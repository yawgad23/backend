import express, { type Express, type Request, type Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  db: null as any, verify: vi.fn(), get: vi.fn(), list: vi.fn(),
  createTransport: vi.fn(), sendMail: vi.fn(), close: vi.fn(),
}));
// Never import a live Firebase initializer or create a real SMTP transport.
vi.mock('./firebaseAdmin', () => ({ getAdminDb: () => mocks.db,
  getAdminAuth: () => ({ verifyIdToken: mocks.verify }), adminFirestore: { get: mocks.get, list: mocks.list } }));
vi.mock('nodemailer', () => ({ default: { createTransport: mocks.createTransport } }));
import { createAdministratorAccessProof } from './adminAccessCode';
import { executeSupportReply, registerAdminSupportReplyRoutes, supportReplyIdentifier,
  SupportReplyRequestError, type SupportReplyDependencies } from './adminSupportReplies';

const ticketId = 'ticket-1';
const actor = 'admin@example.com';
const pin = 'offline-test-access-code';
const requestId = '11111111-1111-4111-8111-111111111111';
const otherRequestId = '22222222-2222-4222-8222-222222222222';
const body = { requestId, message: 'We are checking your trip.' };
const replyId = supportReplyIdentifier(ticketId, actor, requestId);
const ticketPath = (id = ticketId) => `support_tickets/${id}`;
const replyPath = (id = replyId, ticket = ticketId) => `${ticketPath(ticket)}/replies/${id}`;

type Data = Record<string, any>;
type Item = { data: Data; version: number };
type Ref = { path: string; id: string; collection(name: string): any; get(): Promise<any> };
let documents: Map<string, Item>;
let attempts: number;
let failTerminalCommit: boolean;
let app: Express;

function put(path: string, data: Data) {
  documents.set(path, { data: structuredClone(data), version: (documents.get(path)?.version || 0) + 1 });
}
function data(path: string) { return structuredClone(documents.get(path)?.data); }
function snapshot(ref: Ref, view = documents): any {
  const item = view.get(ref.path);
  return { id: ref.id, ref, exists: Boolean(item), data: () => structuredClone(item?.data) };
}
function reference(path: string): Ref {
  return { path, id: path.split('/').at(-1)!, collection: name => collection(`${path}/${name}`),
    get: async () => snapshot(reference(path)) };
}
function collection(path: string): any {
  return {
    doc: (id: string) => reference(`${path}/${id}`),
    orderBy: (field: string, direction: string) => {
      expect(field).toBe('created_date'); expect(direction).toBe('desc');
      return { limit: (limit: number) => ({ get: async () => ({ docs: [...documents.entries()]
        .filter(([key]) => key.startsWith(`${path}/`) && key.split('/').length === path.split('/').length + 1)
        .sort(([, a], [, b]) => String(b.data.created_date).localeCompare(String(a.data.created_date)))
        .slice(0, limit).map(([key]) => snapshot(reference(key))) }) }) };
    },
  };
}
// An atomic, optimistic transaction fake: concurrent reservations read independent
// snapshots, retry on version conflicts, and cannot partially commit a failed finish.
async function runTransaction(callback: (transaction: any) => Promise<any>) {
  for (let retry = 0; retry < 5; retry++) {
    attempts++;
    const view = structuredClone(documents);
    const reads = new Map<string, number | undefined>();
    const writes: Array<{ ref: Ref; patch: Data; create: boolean }> = [];
    const result = await callback({
      get: async (ref: Ref) => {
        expect(writes).toHaveLength(0); // Firestore requires reads before writes.
        reads.set(ref.path, view.get(ref.path)?.version);
        return snapshot(ref, view);
      },
      create: (ref: Ref, patch: Data) => writes.push({ ref, patch, create: true }),
      update: (ref: Ref, patch: Data) => writes.push({ ref, patch, create: false }),
    });
    if ([...reads].some(([path, version]) => documents.get(path)?.version !== version)) continue;
    if (failTerminalCommit && writes.some(write => ['accepted', 'failed', 'unknown'].includes(write.patch.state))) {
      throw new Error('injected persistence failure; private provider detail');
    }
    const next = structuredClone(documents);
    for (const { ref, patch, create } of writes) {
      const prior = next.get(ref.path);
      if ((create && prior) || (!create && !prior)) throw new Error('invalid fake transaction write');
      next.set(ref.path, { data: { ...prior?.data, ...structuredClone(patch) }, version: (prior?.version || 0) + 1 });
    }
    documents = next;
    return result;
  }
  throw new Error('fake transaction retry limit exceeded');
}

function headers(email = actor, token = 'valid') {
  return { authorization: `Bearer ${token}`,
    'x-hy3n-admin-access': createAdministratorAccessProof(email, pin, Date.now() + 60_000) };
}
// Invoke the handler installed on a real Express route, without opening a socket.
async function invoke(method: 'get' | 'post', options: {
  app?: Express; ticket?: string; body?: unknown; headers?: Record<string, string>;
} = {}) {
  const target = options.app || app;
  const layer = (target as any)._router.stack.find((entry: any) =>
    entry.route?.path === '/api/admin/support/:ticketId/replies' && entry.route.methods[method]);
  expect(layer).toBeDefined();
  let status = 200;
  let result: any;
  const responseHeaders: Record<string, string> = {};
  const response = {
    status(code: number) { status = code; return this; },
    json(value: unknown) { result = value; return this; },
    setHeader(name: string, value: string) { responseHeaders[name.toLowerCase()] = value; return this; },
  };
  const request = { method: method.toUpperCase(), params: { ticketId: options.ticket ?? ticketId },
    body: options.body === undefined ? body : options.body, headers: options.headers ?? headers() };
  await layer.route.stack[0].handle(request as unknown as Request, response as unknown as Response);
  return { status, body: result, headers: responseHeaders };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function injectedDependencies(): SupportReplyDependencies {
  return { store: { history: vi.fn(), reserve: vi.fn(), finish: vi.fn() },
    configured: vi.fn(() => true), send: vi.fn(), authorize: vi.fn(async () => actor) };
}

beforeEach(() => {
  vi.resetAllMocks();
  for (const key of ['SUPPORT_EMAIL_USER', 'SUPPORT_EMAIL_PASS', 'SUPPORT_EMAIL_HOST', 'SUPPORT_EMAIL_PORT',
    'EMAIL_USER', 'EMAIL_PASS', 'EMAIL_HOST', 'EMAIL_PORT']) vi.stubEnv(key, '');
  vi.stubEnv('ADMIN_DASHBOARD_PIN', pin);
  vi.stubEnv('SUPPORT_EMAIL_USER', 'hello@ridehy3n.com'); vi.stubEnv('SUPPORT_EMAIL_PASS', 'offline-test-password');
  vi.stubEnv('SUPPORT_EMAIL_HOST', 'smtp.offline.example');
  documents = new Map(); attempts = 0; failTerminalCommit = false;
  put(ticketPath(), { from_email: ' rider@example.com ', subject: 'Trip question', status: 'Open', admin_reply: 'Legacy saved draft' });
  mocks.db = { collection, runTransaction };
  mocks.verify.mockResolvedValue({ email: actor });
  mocks.get.mockResolvedValue({ is_active: true }); mocks.list.mockResolvedValue([]);
  mocks.createTransport.mockReturnValue({ sendMail: mocks.sendMail, close: mocks.close });
  mocks.sendMail.mockResolvedValue({ accepted: ['rider@example.com'], messageId: 'smtp-provider-id' });
  app = express(); registerAdminSupportReplyRoutes(app);
});
afterEach(() => vi.unstubAllEnvs());

describe('registered GET and POST authorization', () => {
  it.each(['get', 'post'] as const)('honors injected authorize denial before any %s history/write/configuration/SMTP work', async method => {
    const dependencies = injectedDependencies();
    vi.mocked(dependencies.authorize).mockImplementation(async (_request, response) => {
      response.status(403).json({ error: 'Denied by authorization boundary' }); return null;
    });
    const isolated = express(); registerAdminSupportReplyRoutes(isolated, dependencies);
    expect(await invoke(method, { app: isolated })).toMatchObject({ status: 403, body: { error: 'Denied by authorization boundary' } });
    expect(dependencies.authorize).toHaveBeenCalledTimes(1);
    expect(dependencies.store.history).not.toHaveBeenCalled(); expect(dependencies.store.reserve).not.toHaveBeenCalled();
    expect(dependencies.store.finish).not.toHaveBeenCalled(); expect(dependencies.configured).not.toHaveBeenCalled();
    expect(dependencies.send).not.toHaveBeenCalled();
  });

  it.each(['get', 'post'] as const)('requires Firebase identity as well as an access proof on %s', async method => {
    const before = structuredClone(documents);
    expect((await invoke(method, { headers: { 'x-hy3n-admin-access': headers()['x-hy3n-admin-access'] } })).status).toBe(401);
    expect(mocks.verify).not.toHaveBeenCalled(); expect(documents).toEqual(before);
    expect(attempts).toBe(0); expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it.each(['get', 'post'] as const)('rejects inactive non-administrators on %s even with a valid signed proof', async method => {
    mocks.get.mockResolvedValue({ is_active: false }); mocks.list.mockResolvedValue([{ is_active: false }]);
    expect((await invoke(method)).status).toBe(403);
    expect(mocks.get).toHaveBeenCalledWith('admin_access', actor);
    expect(attempts).toBe(0); expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it.each(['get', 'post'] as const)('rejects invalid Firebase sessions before %s data access', async method => {
    mocks.verify.mockRejectedValue(new Error('private Firebase failure'));
    const result = await invoke(method);
    expect(result.status).toBe(401); expect(result.body.error).not.toContain('private Firebase');
    expect(mocks.get).not.toHaveBeenCalled(); expect(attempts).toBe(0); expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it.each(['get', 'post'] as const)('enforces the real server-signed access-code boundary on %s', async method => {
    const proofs = ['', 'invalid-proof', createAdministratorAccessProof('other@example.com', pin, Date.now() + 60_000),
      createAdministratorAccessProof(actor, 'wrong-code', Date.now() + 60_000),
      createAdministratorAccessProof(actor, pin, Date.now() - 60_000)];
    for (const proof of proofs) {
      const result = await invoke(method, { headers: { authorization: 'Bearer valid', 'x-hy3n-admin-access': proof } });
      expect(result).toMatchObject({ status: 401, body: { code: 'ADMIN_ACCESS_CODE_REQUIRED' } });
    }
    expect(attempts).toBe(0); expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it.each(['get', 'post'] as const)('fails closed when the dashboard access code is unconfigured on %s', async method => {
    const proofHeaders = headers(); vi.stubEnv('ADMIN_DASHBOARD_PIN', '');
    expect(await invoke(method, { headers: proofHeaders })).toMatchObject({ status: 401, body: { code: 'ADMIN_ACCESS_CODE_REQUIRED' } });
    expect(attempts).toBe(0); expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it('permits active legacy administrator records only after a valid access proof', async () => {
    mocks.get.mockResolvedValue(null); mocks.list.mockResolvedValue([{ is_active: true }]);
    expect((await invoke('get')).status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith('admin_access', { email: actor }, null, 'desc', 5);
  });
});

describe('strict server-authoritative input and history', () => {
  it.each(['to', 'recipient', 'from', 'sender', 'subject', 'author', 'state', 'cc', 'bcc', 'replyId'])
    ('rejects arbitrary %s payload fields before reserving or sending', async field => {
      expect((await invoke('post', { body: { ...body, [field]: 'attacker@example.com' } })).status).toBe(400);
      expect(attempts).toBe(0); expect(mocks.sendMail).not.toHaveBeenCalled();
    });

  it.each([
    { requestId, message: '' }, { requestId, message: ' \n\t ' }, { requestId, message: 'x'.repeat(5001) },
    { requestId, message: 123 }, { requestId, message: null }, { message: 'Hello' },
    { requestId: 'not-a-uuid', message: 'Hello' }, { requestId: 'x'.repeat(161), message: 'Hello' }, null, [],
  ])('rejects invalid request ID or reply text: %j', async invalid => {
    expect((await invoke('post', { body: invalid })).status).toBe(400);
    expect(attempts).toBe(0); expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it.each(['', '../ticket', 'ticket.with.dot', 'ticket id', 'x'.repeat(161)])('rejects invalid ticket identifier %s on both routes', async ticket => {
    expect((await invoke('get', { ticket })).status).toBe(400);
    expect((await invoke('post', { ticket })).status).toBe(400);
    expect(attempts).toBe(0); expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it('accepts the maximum ticket ID and trimmed 5,000-character reply', async () => {
    const ticket = 'x'.repeat(160); put(ticketPath(ticket), { from_email: 'rider@example.com', status: 'Open' });
    const result = await invoke('post', { ticket, body: { requestId, message: ` \n${'x'.repeat(5000)}\n ` } });
    expect(result.status).toBe(200); expect(result.body.reply.message).toBe('x'.repeat(5000));
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
  });

  it('derives recipient, subject, sender and author exclusively from ticket/server identity', async () => {
    const result = await invoke('post', { body: { ...body, message: '  Thank you.\nWe will help.  ' } });
    expect(result).toMatchObject({ status: 200, headers: { 'cache-control': 'no-store' }, body: { duplicate: false,
      reply: { id: replyId, request_id: requestId, author: actor, recipient: 'rider@example.com',
        sender: 'HY3N <hello@ridehy3n.com>', subject: 'Trip question', message: 'Thank you.\nWe will help.',
        state: 'accepted', provider_message_id: 'smtp-provider-id' } } });
    expect(mocks.verify).toHaveBeenCalledWith('valid');
    expect(mocks.sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'rider@example.com',
      from: 'HY3N <hello@ridehy3n.com>', replyTo: 'hello@ridehy3n.com', subject: 'Re: Trip question',
      messageId: `<support-${replyId}@ridehy3n.com>` }));
    expect(data(ticketPath())).toMatchObject({ status: 'In Progress', admin_reply: 'Thank you.\nWe will help.',
      admin_reply_id: replyId, support_reply_in_flight: null });
  });

  it.each(['', 'not-an-email', 'victim@example.com\r\nBcc: evil@example.com', 'a'.repeat(255) + '@example.com'])
    ('fails before reserving when the server ticket recipient is invalid: %s', async from_email => {
      put(ticketPath(), { from_email, status: 'Open' });
      const before = structuredClone(documents);
      expect((await invoke('post')).status).toBe(400);
      expect(documents).toEqual(before); expect(mocks.sendMail).not.toHaveBeenCalled();
    });

  it('returns 404 on both routes for missing tickets without sending', async () => {
    documents.delete(ticketPath());
    expect((await invoke('get')).status).toBe(404); expect((await invoke('post')).status).toBe(404);
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it('returns only the latest 100 persisted replies in chronological order, never legacy saved text', async () => {
    for (let index = 0; index < 105; index++) {
      put(replyPath(`reply-${index}`), { id: 'untrusted-data-id', message: `Sent ${index}`,
        state: 'accepted', created_date: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString() });
    }
    const result = await invoke('get');
    expect(result).toMatchObject({ status: 200, headers: { 'cache-control': 'no-store' },
      body: { emailConfigured: true, sender: 'HY3N <hello@ridehy3n.com>' } });
    expect(result.body.replies).toHaveLength(100);
    expect(result.body.replies[0]).toMatchObject({ id: 'reply-5', message: 'Sent 5' });
    expect(result.body.replies.at(-1)).toMatchObject({ id: 'reply-104', message: 'Sent 104' });
    expect(JSON.stringify(result.body)).not.toContain('Legacy saved draft');
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it('reports an unconfigured mailbox truthfully in history', async () => {
    vi.stubEnv('SUPPORT_EMAIL_PASS', '');
    expect(await invoke('get')).toMatchObject({ status: 200, body: { replies: [], emailConfigured: false } });
    expect(mocks.createTransport).not.toHaveBeenCalled();
  });

  it('maps injected history errors without exposing internal diagnostics', async () => {
    const deps = injectedDependencies(); const isolated = express(); registerAdminSupportReplyRoutes(isolated, deps);
    vi.mocked(deps.store.history).mockRejectedValue(new Error('private database detail'));
    const result = await invoke('get', { app: isolated });
    expect(result.status).toBe(503); expect(result.body.error).not.toContain('private database');
    vi.mocked(deps.store.history).mockRejectedValue(new SupportReplyRequestError(404, 'Missing ticket'));
    expect(await invoke('get', { app: isolated })).toMatchObject({ status: 404, body: { error: 'Missing ticket' } });
  });
});

describe('atomic reservations, idempotency and per-ticket locks', () => {
  it('uses deterministic collision-resistant keys scoped to ticket, administrator and request', () => {
    expect(replyId).toMatch(/^[a-f0-9]{64}$/);
    expect(supportReplyIdentifier(ticketId, actor, requestId)).toBe(replyId);
    expect(new Set([replyId, supportReplyIdentifier('ticket-2', actor, requestId),
      supportReplyIdentifier(ticketId, 'other@example.com', requestId),
      supportReplyIdentifier(ticketId, actor, otherRequestId)]).size).toBe(4);
  });

  it.each(['accepted', 'failed', 'unknown'] as const)('replays a terminal %s record without any second SMTP attempt', async state => {
    if (state === 'failed') mocks.sendMail.mockRejectedValue(Object.assign(new Error('rejected'), { code: 'EAUTH' }));
    if (state === 'unknown') mocks.sendMail.mockRejectedValue(Object.assign(new Error('ambiguous'), { code: 'ETIMEDOUT' }));
    const first = await invoke('post'); const before = structuredClone(documents);
    const second = await invoke('post');
    expect(first.body.reply.state).toBe(state); expect(second.body.duplicate).toBe(true);
    expect(second.body.reply).toEqual(first.body.reply); expect(documents).toEqual(before);
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
  });

  it('rejects reusing a request key for changed text without another send', async () => {
    await invoke('post');
    expect((await invoke('post', { body: { ...body, message: 'Different reply' } })).status).toBe(409);
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
  });

  it('replays an in-flight identical request and blocks another key until acceptance', async () => {
    const started = deferred<void>(); const completion = deferred<any>();
    mocks.sendMail.mockImplementationOnce(() => { started.resolve(); return completion.promise; });
    const first = invoke('post'); await started.promise;
    expect(data(ticketPath())?.support_reply_in_flight).toBe(replyId);
    const duplicate = await invoke('post');
    expect(duplicate).toMatchObject({ status: 202, body: { duplicate: true, reply: { id: replyId, state: 'sending' } } });
    expect((await invoke('post', { body: { ...body, requestId: otherRequestId } })).status).toBe(409);
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    completion.resolve({ accepted: ['rider@example.com'], messageId: 'accepted-after-wait' });
    expect((await first).status).toBe(200);
    expect(data(ticketPath())?.support_reply_in_flight).toBeNull();
  });

  it('retries conflicting simultaneous reservations and sends exactly once for the same key', async () => {
    const started = deferred<void>(); const completion = deferred<any>();
    mocks.sendMail.mockImplementationOnce(() => { started.resolve(); return completion.promise; });
    const first = invoke('post'); const second = invoke('post'); await started.promise;
    completion.resolve({ accepted: ['rider@example.com'], messageId: 'one-send-only' });
    const results = await Promise.all([first, second]);
    expect(results.filter(result => result.body.duplicate)).toHaveLength(1);
    expect(results.map(result => result.status)).toContain(200);
    expect(mocks.sendMail).toHaveBeenCalledTimes(1); expect(attempts).toBeGreaterThanOrEqual(4);
    expect([...documents.keys()].filter(key => key.includes('/replies/'))).toEqual([replyPath()]);
  });

  it('locks the whole ticket across different administrators while allowing another ticket', async () => {
    const started = deferred<void>(); const completion = deferred<any>();
    mocks.sendMail.mockImplementationOnce(() => { started.resolve(); return completion.promise; });
    const first = invoke('post'); await started.promise;
    const before = structuredClone(documents);
    mocks.verify.mockResolvedValue({ email: 'other@example.com' });
    expect((await invoke('post', { headers: headers('other@example.com') })).status).toBe(409);
    expect(documents).toEqual(before);
    put(ticketPath('ticket-2'), { from_email: 'rider@example.com', status: 'Open' });
    expect((await invoke('post', { ticket: 'ticket-2', headers: headers('other@example.com') })).status).toBe(200);
    completion.resolve({ accepted: ['rider@example.com'] }); await first;
    expect(mocks.sendMail).toHaveBeenCalledTimes(2);
  });

  it.each(['accepted', 'failed'] as const)('clears the lock after %s so an explicit new request may send', async state => {
    if (state === 'failed') mocks.sendMail.mockRejectedValueOnce(Object.assign(new Error('auth failed'), { code: 'EAUTH' }));
    expect((await invoke('post')).body.reply.state).toBe(state);
    expect(data(ticketPath())?.support_reply_in_flight).toBeNull();
    expect((await invoke('post', { body: { ...body, requestId: otherRequestId } })).status).toBe(200);
    expect(mocks.sendMail).toHaveBeenCalledTimes(2);
  });

  it('preserves unknown delivery and its lock, retaining the saved draft and blocking blind resends', async () => {
    mocks.sendMail.mockRejectedValue(Object.assign(new Error('private timeout detail'), { code: 'ETIMEDOUT' }));
    const first = await invoke('post');
    expect(first).toMatchObject({ status: 202, body: { reply: { state: 'unknown', message: body.message } } });
    expect(data(ticketPath())).toMatchObject({ support_reply_in_flight: replyId, status: 'Open', admin_reply: 'Legacy saved draft' });
    expect(first.body).not.toHaveProperty('error');
    expect((await invoke('post', { body: { ...body, requestId: otherRequestId } })).status).toBe(409);
    expect((await invoke('get')).body.replies[0].state).toBe('unknown');
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
  });

  it('keeps sending plus its lock after SMTP acceptance but persistence failure, without resending', async () => {
    failTerminalCommit = true;
    const first = await invoke('post');
    expect(first.status).toBe(503); expect(first.body.error).not.toContain('private provider');
    expect(data(replyPath())?.state).toBe('sending');
    expect(data(ticketPath())).toMatchObject({ support_reply_in_flight: replyId, status: 'Open', admin_reply: 'Legacy saved draft' });
    expect(await invoke('post')).toMatchObject({ status: 202, body: { duplicate: true, reply: { state: 'sending' } } });
    expect((await invoke('post', { body: { ...body, requestId: otherRequestId } })).status).toBe(409);
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
  });

  it.each(['EAUTH', 'ETIMEDOUT'])('also retains sending and the lock if persisting the %s outcome fails', async code => {
    failTerminalCommit = true; mocks.sendMail.mockRejectedValue(Object.assign(new Error('SMTP error'), { code }));
    expect((await invoke('post')).status).toBe(503);
    expect(data(replyPath())?.state).toBe('sending'); expect(data(ticketPath())?.support_reply_in_flight).toBe(replyId);
    expect((await invoke('post')).body.duplicate).toBe(true); expect(mocks.sendMail).toHaveBeenCalledTimes(1);
  });

  it('records unconfigured delivery as failed without constructing SMTP or overwriting legacy text', async () => {
    vi.stubEnv('SUPPORT_EMAIL_PASS', '');
    const first = await invoke('post');
    expect(first).toMatchObject({ status: 502, body: { duplicate: false, reply: { state: 'failed', message: body.message } } });
    expect(first.body.error).toContain('draft is retained');
    expect(data(ticketPath())).toMatchObject({ support_reply_in_flight: null, status: 'Open', admin_reply: 'Legacy saved draft' });
    expect(mocks.createTransport).not.toHaveBeenCalled(); expect(mocks.sendMail).not.toHaveBeenCalled();
    vi.stubEnv('SUPPORT_EMAIL_PASS', 'now-configured-test-password');
    expect((await invoke('post')).body.duplicate).toBe(true); expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it('records rejection as failed, clears the lock, and never claims the old saved reply was sent', async () => {
    mocks.sendMail.mockResolvedValue({ accepted: [], rejected: ['rider@example.com'] });
    expect(await invoke('post')).toMatchObject({ status: 502, body: { reply: { state: 'failed' } } });
    expect(data(ticketPath())).toMatchObject({ support_reply_in_flight: null, status: 'Open', admin_reply: 'Legacy saved draft' });
    expect(data(replyPath())).not.toHaveProperty('provider_message_id'); expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it.each(['Closed', 'Resolved', 'In Progress'])('preserves %s ticket status after accepted mail', async status => {
    put(ticketPath(), { ...data(ticketPath()), status });
    expect((await invoke('post')).status).toBe(200);
    expect(data(ticketPath())).toMatchObject({ status, support_reply_in_flight: null, admin_reply: body.message });
  });

  it('treats unexpected injected sender exceptions as unknown, not definite failure', async () => {
    const deps = injectedDependencies();
    const reply = { id: replyId, request_id: requestId, message: body.message, author: actor,
      recipient: 'rider@example.com', sender: 'HY3N <hello@ridehy3n.com>', subject: 'Ticket', state: 'sending' as const,
      created_date: '2026-11-26T00:00:00.000Z' };
    vi.mocked(deps.store.reserve).mockResolvedValue({ reply, created: true });
    vi.mocked(deps.send).mockRejectedValue(new Error('unexpected sender failure'));
    vi.mocked(deps.store.finish).mockImplementation(async (_ticket, value, state) => ({ ...value, state }));
    expect((await executeSupportReply(ticketId, actor, body, deps)).reply.state).toBe('unknown');
    expect(deps.store.finish).toHaveBeenCalledWith(ticketId, reply, 'unknown');
  });
});
