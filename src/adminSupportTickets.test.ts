import express, { type Express, type Request, type Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ db: null as any, verify: vi.fn(), get: vi.fn(), list: vi.fn() }));
// No Firebase initializer, credentials, network, SMTP or live records are used.
vi.mock('./firebaseAdmin', () => ({ getAdminDb: () => mocks.db,
  getAdminAuth: () => ({ verifyIdToken: mocks.verify }), adminFirestore: { get: mocks.get, list: mocks.list } }));
import { createAdministratorAccessProof } from './adminAccessCode';
import { createFirestoreSupportTicketStore, normalizeSupportTicket, registerAdminSupportTicketRoutes,
  SupportTicketRequestError, type SupportTicketDependencies } from './adminSupportTickets';

const actor = 'legacy-admin@example.com';
const pin = 'offline-ticket-access-code';
const ticketId = 'ticket-1';
const timestamp = '2026-11-26T08:00:00.000Z';
const ticketPath = (id = ticketId) => `support_tickets/${id}`;
const input = { subject: 'Trip question', message: 'Please check my ride.', from_name: 'Customer',
  from_email: 'customer@example.com', category: 'website_contact', priority: 'Medium', status: 'Open' };
const methods = ['get', 'post', 'patch', 'delete'] as const;
type Method = typeof methods[number];
type Data = Record<string, any>;
type Item = { data: Data; version: number };
type Ref = { path: string; id: string };
let documents: Map<string, Item>;
let app: Express;
let attempts: number;
let writes: Array<{ ref: Ref; patch: Data }>;
let queries: Array<{ field: string; direction: string; limit: number }>;
let additions: Data[];
let failCommit: boolean;
let onRead: (() => void) | undefined;

function put(path: string, data: Data) {
  documents.set(path, { data: structuredClone(data), version: (documents.get(path)?.version || 0) + 1 });
}
function data(path = ticketPath()) { return structuredClone(documents.get(path)?.data); }
function reference(path: string): Ref { return { path, id: path.split('/').at(-1)! }; }
function snapshot(ref: Ref, view = documents): any {
  const item = view.get(ref.path);
  return { id: ref.id, ref, exists: Boolean(item), data: () => structuredClone(item?.data) };
}
function collection(path: string): any {
  return {
    doc: (id: string) => reference(`${path}/${id}`),
    add: async (payload: Data) => {
      additions.push(structuredClone(payload));
      const ref = reference(`${path}/generated-ticket-${additions.length}`); put(ref.path, payload); return ref;
    },
    orderBy: (field: string, direction: string) => ({ limit: (limit: number) => ({ get: async () => {
      queries.push({ field, direction, limit });
      return { docs: [...documents.entries()]
        .filter(([key]) => key.startsWith(`${path}/`) && key.split('/').length === path.split('/').length + 1)
        .sort(([, a], [, b]) => String(b.data[field]).localeCompare(String(a.data[field])))
        .slice(0, limit).map(([key]) => snapshot(reference(key))) };
    } }) }),
  };
}
// Optimistic transaction fake enforces read-before-write, retries changed ticket
// versions, and commits atomically. Reply subcollections cannot be deleted here.
async function runTransaction(callback: (transaction: any) => Promise<any>) {
  for (let retry = 0; retry < 5; retry++) {
    attempts++;
    const view = structuredClone(documents);
    const reads = new Map<string, number | undefined>();
    const pending: Array<{ ref: Ref; patch: Data }> = [];
    const result = await callback({
      get: async (ref: Ref) => {
        expect(pending).toHaveLength(0);
        reads.set(ref.path, view.get(ref.path)?.version);
        const value = snapshot(ref, view); const hook = onRead; onRead = undefined; hook?.(); return value;
      },
      update: (ref: Ref, patch: Data) => pending.push({ ref, patch: structuredClone(patch) }),
    });
    if ([...reads].some(([path, version]) => documents.get(path)?.version !== version)) continue;
    if (failCommit) throw new Error('private Firestore diagnostic');
    const next = structuredClone(documents);
    for (const { ref, patch } of pending) {
      const prior = next.get(ref.path);
      if (!prior) throw new Error('cannot update missing fake document');
      next.set(ref.path, { data: { ...prior.data, ...patch }, version: prior.version + 1 });
    }
    documents = next; writes.push(...pending); return result;
  }
  throw new Error('fake transaction retry limit');
}
function headers(email = actor) {
  return { authorization: 'Bearer offline-token',
    'x-hy3n-admin-access': createAdministratorAccessProof(email, pin, Date.now() + 60_000) };
}
// Direct invocation of the actual handler registered on a real Express app,
// without opening even a local network socket.
async function invoke(method: Method, options: {
  app?: Express; ticket?: string; body?: unknown; headers?: Record<string, string>;
} = {}) {
  const path = method === 'get' || method === 'post' ? '/api/admin/support' : '/api/admin/support/:ticketId';
  const layer = ((options.app || app) as any)._router.stack.find((entry: any) => entry.route?.path === path && entry.route.methods[method]);
  expect(layer).toBeDefined();
  let status = 200; let result: any;
  const responseHeaders: Record<string, string> = {};
  const response = {
    status(code: number) { status = code; return this; },
    json(value: unknown) { result = value; return this; },
    setHeader(name: string, value: string) { responseHeaders[name.toLowerCase()] = value; return this; },
  };
  const request = { method: method.toUpperCase(), params: { ticketId: options.ticket ?? ticketId },
    body: options.body === undefined ? input : options.body, headers: options.headers ?? headers() };
  await layer.route.stack[0].handle(request as unknown as Request, response as unknown as Response);
  return { status, body: result, headers: responseHeaders };
}
function injectedDependencies(): SupportTicketDependencies {
  return { store: { list: vi.fn(async () => []), create: vi.fn(), patch: vi.fn(), archive: vi.fn() },
    authorize: vi.fn(async () => actor) };
}
function expectNoStoreAccess() {
  expect(attempts).toBe(0); expect(queries).toHaveLength(0); expect(additions).toHaveLength(0); expect(writes).toHaveLength(0);
}

beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv('ADMIN_DASHBOARD_PIN', pin);
  documents = new Map(); attempts = 0; writes = []; queries = []; additions = []; failCommit = false; onRead = undefined;
  put(ticketPath(), { ...input, created_date: timestamp, updated_date: timestamp, source: 'website',
    source_form: 'contact', user_type: 'website_visitor', user_id: 'real-associated-user',
    admin_reply: 'Retained old reply', admin_reply_id: 'old-reply', support_reply_in_flight: null,
    website_intake: { city: 'Accra' }, resolved_at: null });
  put(`${ticketPath()}/replies/old-reply`, { message: 'Audit message', state: 'accepted', created_date: timestamp });
  mocks.db = { collection, runTransaction };
  mocks.verify.mockResolvedValue({ email: actor }); mocks.get.mockResolvedValue({ is_active: true }); mocks.list.mockResolvedValue([]);
  app = express(); registerAdminSupportTicketRoutes(app);
});
afterEach(() => vi.unstubAllEnvs());

describe('real registered support-ticket handler authorization', () => {
  it.each(methods)('denies injected authorization before %s store work and makes denial non-cacheable', async method => {
    const deps = injectedDependencies();
    vi.mocked(deps.authorize).mockImplementation(async (_request, response) => { response.status(403).json({ error: 'Denied' }); return null; });
    const isolated = express(); registerAdminSupportTicketRoutes(isolated, deps);
    expect(await invoke(method, { app: isolated })).toMatchObject({ status: 403, body: { error: 'Denied' }, headers: { 'cache-control': 'no-store' } });
    expect(deps.authorize).toHaveBeenCalledTimes(1);
    for (const operation of Object.values(deps.store)) expect(operation).not.toHaveBeenCalled();
  });
  it.each(methods)('requires Firebase identity before %s even when a proof is present', async method => {
    const before = structuredClone(documents);
    expect(await invoke(method, { headers: { 'x-hy3n-admin-access': headers()['x-hy3n-admin-access'] } }))
      .toMatchObject({ status: 401, headers: { 'cache-control': 'no-store' } });
    expect(mocks.verify).not.toHaveBeenCalled(); expect(documents).toEqual(before); expectNoStoreAccess();
  });
  it.each(methods)('rejects non-administrators with signed proof before %s', async method => {
    mocks.get.mockResolvedValue({ is_active: false }); mocks.list.mockResolvedValue([{ is_active: false }]);
    expect((await invoke(method)).status).toBe(403); expectNoStoreAccess();
  });
  it.each(methods)('rejects expired Firebase sessions before %s data access', async method => {
    mocks.verify.mockRejectedValue(new Error('private Firebase failure'));
    const result = await invoke(method); expect(result.status).toBe(401); expect(result.body.error).not.toContain('private Firebase');
    expect(mocks.get).not.toHaveBeenCalled(); expectNoStoreAccess();
  });
  it.each(methods)('enforces valid matching signed administrator proof on %s', async method => {
    const proofs = ['', 'invalid', createAdministratorAccessProof('other@example.com', pin, Date.now() + 60_000),
      createAdministratorAccessProof(actor, 'wrong-code', Date.now() + 60_000), createAdministratorAccessProof(actor, pin, Date.now() - 60_000)];
    for (const proof of proofs) expect(await invoke(method, { headers: { authorization: 'Bearer offline-token', 'x-hy3n-admin-access': proof } }))
      .toMatchObject({ status: 401, body: { code: 'ADMIN_ACCESS_CODE_REQUIRED' }, headers: { 'cache-control': 'no-store' } });
    expectNoStoreAccess();
  });
  it.each(methods)('fails closed when the administrator PIN is unconfigured on %s', async method => {
    const proof = headers(); vi.stubEnv('ADMIN_DASHBOARD_PIN', '');
    expect(await invoke(method, { headers: proof })).toMatchObject({ status: 401, body: { code: 'ADMIN_ACCESS_CODE_REQUIRED' } });
    expectNoStoreAccess();
  });
  it.each(methods)('permits active legacy administrator plus proof on %s without changing account records', async method => {
    mocks.get.mockResolvedValue(null); mocks.list.mockResolvedValue([{ id: 'generated-legacy-id', email: actor, is_active: true }]);
    expect((await invoke(method)).status).toBe(method === 'post' ? 201 : 200);
    expect(mocks.get).toHaveBeenCalledWith('admin_access', actor);
    expect(mocks.list).toHaveBeenCalledWith('admin_access', { email: actor }, null, 'desc', 5);
    expect(mocks.verify).toHaveBeenCalledWith('offline-token');
  });
  it('still denies legacy administrator access without the signed proof', async () => {
    mocks.get.mockResolvedValue(null); mocks.list.mockResolvedValue([{ is_active: true }]);
    expect(await invoke('get', { headers: { authorization: 'Bearer offline-token' } }))
      .toMatchObject({ status: 401, body: { code: 'ADMIN_ACCESS_CODE_REQUIRED' } });
    expectNoStoreAccess();
  });
});

describe('strict metadata allowlist and server-owned values', () => {
  it.each(['admin_reply', 'admin_reply_id', 'admin_reply_at', 'support_reply_in_flight', 'id', 'user_id', 'user_type',
    'source', 'source_form', 'website_intake', 'created_date', 'updated_date', 'resolved_at', 'archived', 'archived_at',
    'replies', 'recipient', 'author', 'unrecognized_field'])('rejects forbidden %s on create and patch before store access', async field => {
    const before = structuredClone(documents);
    expect((await invoke('post', { body: { ...input, [field]: 'forged' } })).status).toBe(400);
    expect((await invoke('patch', { body: { subject: 'Updated', [field]: 'forged' } })).status).toBe(400);
    expectNoStoreAccess(); expect(documents).toEqual(before);
  });
  it.each([
    { subject: '' }, { subject: ' \n ' }, { subject: 'x'.repeat(161) }, { subject: 1 },
    { message: '' }, { message: '\t ' }, { message: 'x'.repeat(10001) }, { message: null },
    { from_name: '' }, { from_name: ' ' }, { from_name: 'x'.repeat(161) },
    { from_email: 'not-email' }, { from_email: 'customer@example.com\r\nBcc: evil@example.com' }, { from_email: 'x'.repeat(255) },
    { from_phone: 'x'.repeat(41) }, { category: 'x'.repeat(101) }, { related_ride_id: 'x'.repeat(161) },
    { priority: 'Critical' }, { priority: 'high' }, { status: 'open' }, { status: 'Deleted' }, { status: null },
  ])('rejects invalid metadata on both write routes: %j', async invalid => {
    expect((await invoke('post', { body: { ...input, ...invalid } })).status).toBe(400);
    expect((await invoke('patch', { body: invalid })).status).toBe(400); expectNoStoreAccess();
  });
  it.each([null, [], 'not-object', 123])('rejects malformed create and patch bodies: %j', async invalid => {
    expect((await invoke('post', { body: invalid })).status).toBe(400);
    expect((await invoke('patch', { body: invalid })).status).toBe(400); expectNoStoreAccess();
  });
  it('requires all three substantive fields on create but accepts a nonempty partial patch', async () => {
    for (const field of ['subject', 'message', 'from_name']) {
      const body: Data = { ...input }; delete body[field]; expect((await invoke('post', { body })).status).toBe(400);
    }
    expect((await invoke('patch', { body: {} })).status).toBe(400); expectNoStoreAccess();
    expect(await invoke('patch', { body: { priority: 'Urgent' } })).toMatchObject({ status: 200, body: { ticket: { priority: 'Urgent', subject: input.subject } } });
  });
  it('accepts trimmed length boundaries and blank email without permitting header injection', async () => {
    const body = { subject: `  ${'s'.repeat(160)}  `, message: `\n${'m'.repeat(10000)}\n`, from_name: ` ${'n'.repeat(160)} `,
      from_email: ' \t ', from_phone: 'p'.repeat(40), category: 'c'.repeat(100), related_ride_id: 'r'.repeat(160), priority: 'Low' };
    const result = await invoke('post', { body });
    expect(result.status).toBe(201); expect(result.body.ticket).toMatchObject({ subject: 's'.repeat(160), message: 'm'.repeat(10000),
      from_name: 'n'.repeat(160), from_email: '', from_phone: body.from_phone, category: body.category, related_ride_id: body.related_ride_id });
  });
  it.each(['Low', 'Medium', 'High', 'Urgent'])('retains exact priority %s', async priority => {
    expect(await invoke('patch', { body: { priority } })).toMatchObject({ status: 200, body: { ticket: { priority } } });
  });
  it.each(['Open', 'In Progress', 'Resolved', 'Closed'])('retains exact status %s', async status => {
    expect(await invoke('patch', { body: { status } })).toMatchObject({ status: 200, body: { ticket: { status } } });
  });
  it.each(['website_contact', 'website_application', 'application', 'complaint', 'sos'])('preserves category %s on patch', async category => {
    expect(await invoke('patch', { body: { category } })).toMatchObject({ status: 200, body: { ticket: { category } } });
  });
  it('creates server-owned provenance, timestamps and sensible defaults', async () => {
    const result = await invoke('post', { body: { subject: ' New ticket ', message: ' Please help. ', from_name: ' Administrator ' } });
    expect(result).toMatchObject({ status: 201, headers: { 'cache-control': 'no-store' }, body: { ticket: {
      id: 'generated-ticket-1', source: 'admin', user_type: 'admin_created', status: 'Open', priority: 'Medium',
      subject: 'New ticket', message: 'Please help.', from_name: 'Administrator', resolved_at: null } } });
    expect(result.body.ticket.created_date).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(result.body.ticket.updated_date).toBe(result.body.ticket.created_date);
    expect(result.body.ticket).not.toHaveProperty('user_id'); expect(result.body.ticket).not.toHaveProperty('admin_reply');
    expect(data('support_tickets/generated-ticket-1')).toEqual(additions[0]);
  });
  it('revalidates strict input at the injectable store boundary too', async () => {
    const store = createFirestoreSupportTicketStore();
    await expect(store.create({ ...input, user_id: 'forged' } as any)).rejects.toMatchObject({ status: 400 });
    await expect(store.patch(ticketId, { admin_reply: 'forged' } as any)).rejects.toMatchObject({ status: 400 });
    expectNoStoreAccess();
  });
});

describe('list and timestamp response normalization', () => {
  it('queries only the latest 200 tickets descending and never includes nested reply documents', async () => {
    documents.clear();
    for (let index = 0; index < 205; index++) put(ticketPath(`ticket-${index}`), { subject: `Ticket ${index}`,
      created_date: new Date(Date.UTC(2026, 10, 26, 0, index)).toISOString(), id: 'untrusted-stored-id' });
    put(`${ticketPath('ticket-204')}/replies/audit`, { created_date: '2999-01-01T00:00:00.000Z' });
    const result = await invoke('get');
    expect(result.status).toBe(200); expect(result.body.tickets).toHaveLength(200);
    expect(result.body.tickets[0]).toMatchObject({ id: 'ticket-204', subject: 'Ticket 204' });
    expect(result.body.tickets.at(-1)).toMatchObject({ id: 'ticket-5', subject: 'Ticket 5' });
    expect(queries).toEqual([{ field: 'created_date', direction: 'desc', limit: 200 }]);
  });
  it('omits archived true tickets while keeping legacy records without an archived field', async () => {
    put(ticketPath('archived'), { subject: 'Hidden', created_date: timestamp, archived: true });
    put(ticketPath('not-archived'), { subject: 'Visible', created_date: timestamp, archived: false });
    expect((await invoke('get')).body.tickets.map((ticket: Data) => ticket.id).sort()).toEqual(['not-archived', ticketId].sort());
  });
  it('normalizes Firestore Timestamp, Date, serialized timestamps and nested dates to ISO strings', () => {
    const result = normalizeSupportTicket({ id: 'forged', created_date: { toDate: () => new Date(timestamp) },
      updated_date: new Date(timestamp), resolved_at: { seconds: 0, nanoseconds: 123000000 },
      archived_at: { _seconds: 1, _nanoseconds: 0 }, admin_reply_at: '2026-11-26T09:00:00+01:00',
      nested: { events: [{ at: new Date(timestamp) }] }, subject: 'Keep text', from_phone: '123' }, ticketId);
    expect(result).toEqual({ id: ticketId, created_date: timestamp, updated_date: timestamp, resolved_at: '1970-01-01T00:00:00.123Z',
      archived_at: '1970-01-01T00:00:01.000Z', admin_reply_at: timestamp, nested: { events: [{ at: timestamp }] }, subject: 'Keep text', from_phone: '123' });
  });
  it('normalizes actual GET response fields and server authority over document ID', async () => {
    put(ticketPath(), { ...data(), id: 'forged', created_date: new Date(timestamp), updated_date: { seconds: 0, nanoseconds: 0 }, resolved_at: null });
    expect(await invoke('get')).toMatchObject({ status: 200, headers: { 'cache-control': 'no-store' }, body: {
      tickets: [{ id: ticketId, created_date: timestamp, updated_date: '1970-01-01T00:00:00.000Z', resolved_at: null }] } });
  });
  it('normalizes injected store results and also omits injected archived tickets', async () => {
    const deps = injectedDependencies();
    vi.mocked(deps.store.list).mockResolvedValue([{ id: ticketId, created_date: new Date(timestamp) }, { id: 'hidden', archived: true }]);
    const isolated = express(); registerAdminSupportTicketRoutes(isolated, deps);
    expect(await invoke('get', { app: isolated })).toMatchObject({ body: { tickets: [{ id: ticketId, created_date: timestamp }] } });
  });
  it('represents invalid stored dates safely instead of throwing or leaking timestamp objects', () => {
    expect(normalizeSupportTicket({ created_date: 'bad-date', resolved_at: new Date('invalid') }, ticketId))
      .toEqual({ id: ticketId, created_date: null, resolved_at: null });
  });
});

describe('narrow transactional edits, reply lock and retained archive audit', () => {
  it('patches only supplied metadata and updated_date, preserving provenance, account and every reply', async () => {
    const original = data()!; const replies = data(`${ticketPath()}/replies/old-reply`);
    expect(await invoke('patch', { body: { subject: ' Updated subject ', from_email: ' updated@example.com ' } }))
      .toMatchObject({ status: 200, headers: { 'cache-control': 'no-store' }, body: { ticket: { subject: 'Updated subject', from_email: 'updated@example.com',
        source: original.source, user_type: original.user_type, user_id: original.user_id, admin_reply: original.admin_reply, admin_reply_id: original.admin_reply_id } } });
    expect(Object.keys(writes[0].patch).sort()).toEqual(['from_email', 'subject', 'updated_date']);
    expect(data()).toMatchObject({ ...original, subject: 'Updated subject', from_email: 'updated@example.com', updated_date: expect.any(String) });
    expect(data(`${ticketPath()}/replies/old-reply`)).toEqual(replies);
  });
  it.each(['patch', 'delete'] as const)('rejects %s while reply delivery is sending or unknown', async method => {
    put(ticketPath(), { ...data(), support_reply_in_flight: 'reply-sending-or-unknown' });
    const before = structuredClone(documents);
    expect(await invoke(method, { body: { from_email: 'changed@example.com', subject: 'Changed' } }))
      .toMatchObject({ status: 409, headers: { 'cache-control': 'no-store' } });
    expect(documents).toEqual(before); expect(writes).toHaveLength(0);
  });
  it.each([null, ''])('permits edits with cleared reply lock %j', async support_reply_in_flight => {
    put(ticketPath(), { ...data(), support_reply_in_flight });
    expect((await invoke('patch', { body: { message: 'Edited message' } })).status).toBe(200);
  });
  it.each(['patch', 'delete'] as const)('retries a conflicting %s snapshot and rejects the newly acquired reply lock', async method => {
    onRead = () => put(ticketPath(), { ...data(), support_reply_in_flight: 'concurrently-reserved-reply' });
    expect((await invoke(method, { body: { from_email: 'changed@example.com' } })).status).toBe(409);
    expect(attempts).toBe(2); expect(writes).toHaveLength(0);
    expect(data()).toMatchObject({ from_email: input.from_email, support_reply_in_flight: 'concurrently-reserved-reply' });
  });
  it('retries a concurrent unrelated metadata change and preserves that change', async () => {
    onRead = () => put(ticketPath(), { ...data(), priority: 'High', admin_reply: 'Concurrent accepted reply' });
    const result = await invoke('patch', { body: { subject: 'Updated subject' } });
    expect(result).toMatchObject({ status: 200, body: { ticket: { subject: 'Updated subject', priority: 'High', admin_reply: 'Concurrent accepted reply' } } });
    expect(attempts).toBe(2); expect(writes).toHaveLength(1);
  });
  it.each(['Resolved', 'Closed'] as const)('owns resolved_at for %s and retains the first resolution timestamp', async status => {
    const store = createFirestoreSupportTicketStore(() => mocks.db, () => timestamp);
    expect((await store.patch(ticketId, { status })).resolved_at).toBe(timestamp);
    const later = createFirestoreSupportTicketStore(() => mocks.db, () => '2026-11-27T08:00:00.000Z');
    expect((await later.patch(ticketId, { priority: 'High' })).resolved_at).toBe(timestamp);
    expect((await later.patch(ticketId, { status: 'Closed' })).resolved_at).toBe(timestamp);
    expect((await later.patch(ticketId, { status: 'In Progress' })).resolved_at).toBeNull();
  });
  it.each(['Resolved', 'Closed'])('sets a server resolution time on create with %s status', async status => {
    const store = createFirestoreSupportTicketStore(() => mocks.db, () => timestamp);
    expect(await store.create({ ...input, status } as any)).toMatchObject({ status, resolved_at: timestamp, created_date: timestamp, updated_date: timestamp });
  });
  it('soft-deletes with a narrow transactional archive update and retains ticket/reply audit', async () => {
    const original = data(); const reply = data(`${ticketPath()}/replies/old-reply`);
    expect(await invoke('delete')).toEqual({ status: 200, body: { deleted: true }, headers: { 'cache-control': 'no-store' } });
    expect(data()).toMatchObject({ ...original, archived: true, archived_at: expect.any(String), updated_date: expect.any(String) });
    expect(data()!.archived_at).toBe(data()!.updated_date);
    expect(Object.keys(writes[0].patch).sort()).toEqual(['archived', 'archived_at', 'updated_date']);
    expect(data(`${ticketPath()}/replies/old-reply`)).toEqual(reply);
    expect((await invoke('get')).body.tickets).toEqual([]);
    expect((await invoke('patch', { body: { status: 'Open' } })).status).toBe(404);
    expect((await invoke('delete')).status).toBe(404);
  });
  it.each(['patch', 'delete'] as const)('returns 404 for a missing ticket on %s without a write', async method => {
    documents.delete(ticketPath());
    expect((await invoke(method, { body: { subject: 'Updated' } })).status).toBe(404); expect(writes).toHaveLength(0);
  });
  it.each(['', '../ticket', 'ticket.with.dot', 'ticket id', 'x'.repeat(161)])('rejects invalid ticket identifier %s', async ticket => {
    expect((await invoke('patch', { ticket, body: { subject: 'Updated' } })).status).toBe(400);
    expect((await invoke('delete', { ticket })).status).toBe(400); expectNoStoreAccess();
  });
  it('accepts a maximum-length valid identifier', async () => {
    const ticket = 'x'.repeat(160); put(ticketPath(ticket), data()!);
    expect((await invoke('patch', { ticket, body: { priority: 'High' } })).status).toBe(200);
  });
  it.each(['patch', 'delete'] as const)('keeps all records unchanged and hides persistence diagnostics on failed %s commit', async method => {
    failCommit = true; const before = structuredClone(documents);
    const result = await invoke(method, { body: { subject: 'Updated' } });
    expect(result.status).toBe(503); expect(result.body.error).not.toContain('private Firestore');
    expect(documents).toEqual(before); expect(writes).toHaveLength(0);
  });
  it.each(methods)('maps injected %s errors safely and preserves explicit store error statuses', async method => {
    const deps = injectedDependencies(); const isolated = express(); registerAdminSupportTicketRoutes(isolated, deps);
    const operation = method === 'get' ? deps.store.list : method === 'post' ? deps.store.create : method === 'patch' ? deps.store.patch : deps.store.archive;
    vi.mocked(operation).mockRejectedValue(new Error('private database detail'));
    const result = await invoke(method, { app: isolated }); expect(result.status).toBe(503); expect(result.body.error).not.toContain('private database');
    vi.mocked(operation).mockRejectedValue(new SupportTicketRequestError(404, 'Missing ticket'));
    expect(await invoke(method, { app: isolated })).toMatchObject({ status: 404, body: { error: 'Missing ticket' }, headers: { 'cache-control': 'no-store' } });
  });
});
