import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ db: null as any, getMetadata: vi.fn(), verifyIdToken: vi.fn(),
  get: vi.fn(), list: vi.fn(), set: vi.fn(), update: vi.fn(), create: vi.fn(), authUpdate: vi.fn(), revoke: vi.fn() }));
vi.mock('./firebaseAdmin', () => ({
  ADMIN_COLLECTIONS: { DRIVER_PROFILES: 'driver_profiles', RIDER_PROFILES: 'rider_profiles' },
  getAdminDb: () => mocks.db, getAdminApp: () => ({ options: { projectId: 'hy3n26' } }),
  getAdminAuth: () => ({ verifyIdToken: mocks.verifyIdToken, updateUser: mocks.authUpdate, revokeRefreshTokens: mocks.revoke }),
  adminFirestore: { get: mocks.get, list: mocks.list, set: mocks.set, update: mocks.update, create: mocks.create },
}));
vi.mock('firebase-admin/storage', () => ({ getStorage: () => ({ bucket: (bucket: string) => ({
  file: (path: string) => ({ getMetadata: () => mocks.getMetadata(bucket, path).then((value: unknown) => [value]) }),
}) }) }));
import { registerAdminAccountRoutes } from './adminAccountRoutes';
import { createAdministratorAccessProof } from './adminAccessCode';
import { DRIVER_DOCUMENT_DEFINITIONS, driverDocumentKeys, DRIVER_DOCUMENT_MAX_BYTES } from './driverDocumentManifest';

const uid = 'driver-1';
const admin = 'admin@example.com';
const bucket = 'hy3n26.firebasestorage.app';
const url = (key: string, owner = uid, bucketName = bucket) => `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(`drivers/${owner}/${key}.jpg`)}?alt=media&token=test-token`;
const required = driverDocumentKeys.filter((key) => DRIVER_DOCUMENT_DEFINITIONS[key].required);
const metadata = { contentType: 'image/jpeg', size: '1024', generation: '123', metadata: { firebaseStorageDownloadTokens: 'test-token' } };
const documents = (count = 6) => Object.fromEntries(required.slice(0, count).map((key) => [DRIVER_DOCUMENT_DEFINITIONS[key].field, url(key)]));

type Stored = { data: Record<string, any>; version: number };
type Reference = { collection: string; id: string };
type Query = { collection: string; owner: string; cap: number };
let store: Map<string, Stored>;
let nextId: number;
let committed: number;
let attempts: number;
let beforeTransaction: (() => void) | null;
let beforeCommit: (() => void) | null;
let failCommit: boolean;
let foreignQuery: boolean;
let readHook: ((collection: string, id: string) => void) | null;
const keyFor = (ref: Reference) => `${ref.collection}/${ref.id}`;
function put(id: string, data: Record<string, any>, collection = 'driver_profiles') {
  const key = `${collection}/${id}`;
  store.set(key, { data: structuredClone(data), version: (store.get(key)?.version || 0) + 1 });
}
function alter(id: string, patch: Record<string, any>, collection = 'driver_profiles') {
  put(id, { ...store.get(`${collection}/${id}`)!.data, ...patch }, collection);
}
function snapshot(ref: Reference, source = store): any {
  const item = source.get(keyFor(ref));
  return { id: ref.id, exists: Boolean(item), data: () => structuredClone(item?.data),
    updateTime: item ? { toDate: () => new Date('2026-11-24T00:00:00Z'), nanoseconds: item.version } : undefined };
}
function queryDocs(query: Query, source = store): any[] {
  const docs = [...source.keys()].filter((key) => key.startsWith(`${query.collection}/`))
    .map((key) => snapshot({ collection: query.collection, id: key.split('/')[1] }, source))
    .filter((doc) => doc.data().user_id === query.owner).sort((a, b) => a.id.localeCompare(b.id)).slice(0, query.cap);
  if (foreignQuery) docs.push(snapshot({ collection: 'driver_profiles', id: 'foreign' }, source));
  return docs;
}
function query(collection: string, owner: string, cap = 100): any {
  const q = { collection, owner, cap };
  return { ...q, orderBy: () => query(collection, owner, cap), limit: (limit: number) => query(collection, owner, limit),
    get: async () => ({ docs: queryDocs(q) }) };
}
function collection(name: string): any {
  return { doc: (id = `event-${++nextId}`) => {
    const ref = { collection: name, id };
    return { ...ref, get: async () => { readHook?.(name, id); return snapshot(ref); } };
  }, where: (field: string, operation: string, owner: string) => {
    expect(field).toBe('user_id'); expect(operation).toBe('=='); return query(name, owner);
  } };
}
async function runTransaction(callback: (tx: any) => Promise<any>) {
  beforeTransaction?.(); beforeTransaction = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    attempts++;
    const view = structuredClone(store);
    const reads = new Map<string, number | undefined>();
    const queries: Query[] = [];
    const writes: { ref: Reference; data: any; kind: string }[] = [];
    const tx = {
      get: async (ref: Reference | Query) => {
        expect(writes).toHaveLength(0); // All reads must precede queued writes.
        if ('owner' in ref) {
          queries.push(ref);
          const docs = queryDocs(ref, view);
          docs.forEach((doc) => reads.set(`${ref.collection}/${doc.id}`, view.get(`${ref.collection}/${doc.id}`)?.version));
          return { docs };
        }
        reads.set(keyFor(ref), view.get(keyFor(ref))?.version);
        return snapshot(ref, view);
      },
      update: (ref: Reference, data: any) => { writes.push({ ref, data, kind: 'update' }); },
      set: (ref: Reference, data: any, options: any) => { expect(options).toEqual({ merge: true }); writes.push({ ref, data, kind: 'set' }); },
      create: (ref: Reference, data: any) => { writes.push({ ref, data, kind: 'create' }); },
    };
    const result = await callback(tx);
    beforeCommit?.(); beforeCommit = null;
    const changed = [...reads].some(([key, version]) => store.get(key)?.version !== version)
      || queries.some((q) => JSON.stringify(queryDocs(q, view).map((d) => [d.id, d.updateTime.nanoseconds])) !== JSON.stringify(queryDocs(q).map((d) => [d.id, d.updateTime.nanoseconds])));
    if (changed) continue;
    if (failCommit) throw new Error('injected atomic write failure');
    for (const write of writes) {
      if (write.kind === 'update' && !store.has(keyFor(write.ref))) throw new Error('missing update target');
      if (write.kind === 'create' && store.has(keyFor(write.ref))) throw new Error('audit event already exists');
    }
    const next = structuredClone(store);
    for (const write of writes) {
      const prior = next.get(keyFor(write.ref));
      next.set(keyFor(write.ref), { data: { ...prior?.data, ...structuredClone(write.data) }, version: (prior?.version || 0) + 1 });
    }
    store = next; committed++; return result;
  }
  throw new Error('transaction contention exhausted');
}

let server: ReturnType<ReturnType<typeof express>['listen']>;
let origin: string;
let pinBefore: string | undefined;
beforeAll(async () => {
  pinBefore = process.env.ADMIN_DASHBOARD_PIN;
  const app = express(); app.use(express.json()); registerAdminAccountRoutes(app);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  if (pinBefore === undefined) delete process.env.ADMIN_DASHBOARD_PIN; else process.env.ADMIN_DASHBOARD_PIN = pinBefore;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  vi.clearAllMocks();
  store = new Map(); nextId = committed = attempts = 0; beforeTransaction = beforeCommit = readHook = null;
  failCommit = foreignQuery = false;
  process.env.ADMIN_DASHBOARD_PIN = 'offline-test-pin';
  mocks.db = { collection, runTransaction };
  mocks.verifyIdToken.mockImplementation(async (token: string) => {
    if (token === 'bad') throw new Error('bad token');
    return { uid: token === 'nonadmin' ? 'nonadmin' : 'admin-uid', email: token === 'nonadmin' ? 'nonadmin@example.com' : admin };
  });
  mocks.get.mockImplementation(async (name, id) => name === 'admin_access' && id === admin ? { is_active: true } : null);
  mocks.list.mockImplementation(async (name) => name === 'account_lifecycle_events'
    ? [...store.entries()].filter(([key]) => key.startsWith('account_lifecycle_events/')).map(([key, item]) => ({ id: key.split('/')[1], ...item.data })) : []);
  mocks.getMetadata.mockResolvedValue(structuredClone(metadata));
  put(uid, { user_id: uid, full_name: 'Kofi Mensah', approval_status: 'pending', ...documents() });
});
function headers() { return { Authorization: 'Bearer valid', 'x-hy3n-admin-access': createAdministratorAccessProof(admin, 'offline-test-pin', Date.now() + 60_000), 'Content-Type': 'application/json' }; }
async function http(path: string, options: RequestInit = {}): Promise<{ status: number; body: any; cache: string | null }> {
  const response = await fetch(`${origin}${path}`, { headers: headers(), ...options });
  return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
}
const review = () => http(`/api/admin/drivers/${uid}/documents`);
const decide = (body: any) => http(`/api/admin/drivers/${uid}/approval`, { method: 'PATCH', body: JSON.stringify(body) });
async function decision(status = 'approved', extra: any = {}) {
  const loaded = await review(); expect(loaded.status).toBe(200);
  return decide({ approvalStatus: status, documentRevision: loaded.body.manifest.documentRevision, ...extra });
}
function profile(id = uid) { return store.get(`driver_profiles/${id}`)!.data; }
function events() { return [...store.entries()].filter(([key]) => key.startsWith('account_lifecycle_events/')).map(([, item]) => item.data); }
function noSideEffects() {
  for (const fn of [mocks.set, mocks.update, mocks.create, mocks.authUpdate, mocks.revoke]) expect(fn).not.toHaveBeenCalled();
}

describe('actual admin HTTP identity plus access-code authorization', () => {
  it.each(['GET', 'PATCH'])('denies anonymous, nonadmin, expired token and missing/invalid proof on %s before document reads', async (method) => {
    const path = `/api/admin/drivers/${uid}/${method === 'GET' ? 'documents' : 'approval'}`;
    for (const [supplied, expected] of [
      [{}, 401], [{ Authorization: 'Bearer nonadmin' }, 403], [{ Authorization: 'Bearer bad' }, 401],
      [{ Authorization: 'Bearer valid' }, 401], [{ Authorization: 'Bearer valid', 'x-hy3n-admin-access': 'invalid' }, 401],
    ] as const) {
      const result = await http(path, { method, headers: supplied });
      expect(result.status).toBe(expected); expect(result.cache).toBe('no-store');
    }
    expect(mocks.getMetadata).not.toHaveBeenCalled(); expect(attempts).toBe(0); noSideEffects();
  });
});

describe('read-only admin document review contract and strict selection', () => {
  it('returns normalized account and exact eight-key manifest without identity/claim writes or autoapproval', async () => {
    alter(uid, { full_name: '', rejection_reason: 'Previous reason', is_test_driver: true, photo_url: 'https://evil.example/photo', account_status: 'inactive' });
    const result = await review();
    expect(result.status).toBe(200); expect(result.cache).toBe('no-store');
    expect(result.body.account).toMatchObject({ userId: uid, role: 'driver', isTestDriver: true,
      accountStatus: 'inactive', approvalStatus: 'pending', rejectionReason: 'Previous reason' });
    expect(result.body.account.documentRevision).toBe(result.body.manifest.documentRevision);
    expect(Object.keys(result.body.manifest.documents)).toEqual(driverDocumentKeys);
    expect(result.body.manifest.documentsComplete).toBe(true);
    expect(profile().approval_status).toBe('pending'); expect(committed).toBe(0); noSideEffects();
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it('never substitutes photo display aliases or arbitrary registration scans for required photos', async () => {
    alter(uid, { profile_photo_url: null, photo_url: url('legacy-selfie'), avatar_url: url('avatar'),
      vehicle_photo_url: null, vehicle_registration_url: url('registration') });
    const result = await review();
    expect(result.body.account.documents.profilePhoto).toBeNull(); expect(result.body.account.documents.vehiclePhoto).toBeNull();
    expect(result.body.account.documents.vehicleRegistration).toBeNull();
    expect(result.body.manifest.missingDocuments).toEqual(['profilePhoto', 'vehiclePhoto']);
  });
  it.each(['vehicle-photo.jpg', 'vehicle_photo.jpg'])('uses only vetted historical vehicle photo %s', async (name) => {
    alter(uid, { vehicle_photo_url: null, vehicle_registration_url: url(name.replace('.jpg', '')) });
    expect((await review()).body.manifest.documents.vehiclePhoto.status).toBe('valid');
  });
  it('allows canonical absent user_id and uses the real document ID, not stored id', async () => {
    put(uid, { ...documents(), id: 'forged-id' });
    const result = await review(); expect(result.status).toBe(200);
    expect(result.body.account.profileId).toBe(uid); expect(result.body.account.userId).toBe(uid);
  });
  it('returns 404 for an absent profile and 403 for a foreign canonical owner', async () => {
    store.delete(`driver_profiles/${uid}`); expect((await review()).status).toBe(404);
    put(uid, { user_id: 'another', ...documents() }); expect((await review()).status).toBe(403);
    expect(mocks.getMetadata).not.toHaveBeenCalled();
  });
  it('rejects foreign query records rather than filtering them into a false safe selection', async () => {
    put('foreign', { user_id: 'other' }); foreignQuery = true;
    const result = await review(); expect(result.status).toBe(403); expect(committed).toBe(0);
  });
  it('allows one owned legacy record but rejects ambiguous legacy-only profiles', async () => {
    store.delete(`driver_profiles/${uid}`); put('legacy', { user_id: uid, ...documents() });
    expect((await review()).body.manifest.profileId).toBe('legacy');
    put('second', { user_id: uid, ...documents() });
    expect((await review()).body.code).toBe('DRIVER_PROFILE_AMBIGUOUS');
  });
  it('canonical selection never merges complete or test-classified legacy records', async () => {
    put(uid, { user_id: uid, approval_status: 'pending' });
    put('legacy', { user_id: uid, is_test_driver: true, approval_status: 'approved', ...documents() });
    const loaded = await review();
    expect(loaded.body.manifest.documentsComplete).toBe(false); expect(loaded.body.account.isTestDriver).toBe(false);
    expect((await decide({ approvalStatus: 'approved', documentRevision: loaded.body.manifest.documentRevision })).status).toBe(422);
  });
  it('fails closed when more than the UID query cap exists; permits the full bounded set', async () => {
    for (let n = 0; n < 19; n++) put(`alias-${n}`, { user_id: uid });
    expect((await review()).status).toBe(200);
    expect((await decision('rejected', { reason: 'Incomplete identification' })).status).toBe(200);
    expect([...store.entries()].filter(([key]) => key.startsWith('driver_profiles/')).every(([, item]) => item.data.approved === false)).toBe(true);
    put('overflow', { user_id: uid, approved: true });
    const result = await review(); expect(result.status).toBe(409); expect(result.body.code).toBe('DRIVER_PROFILE_CAPACITY_EXCEEDED');
  });
});

describe('ordinary six-required-file approval and optional documents', () => {
  it.each([0, 1, 5, 6])('%i valid files do not autoapprove and only six permit ordinary manual approval', async (count) => {
    put(uid, { user_id: uid, approval_status: 'pending', ...documents(count) });
    const loaded = await review(); expect(loaded.body.manifest.documentsComplete).toBe(count === 6);
    expect(profile().approval_status).toBe('pending');
    const result = await decide({ approvalStatus: 'approved', documentRevision: loaded.body.manifest.documentRevision });
    expect(result.status).toBe(count === 6 ? 200 : 422);
    if (count < 6) { expect(result.body.code).toBe('DRIVER_DOCUMENTS_INCOMPLETE'); expect(result.body.missingDocuments).toEqual(required.slice(count)); expect(committed).toBe(0); }
  });
  for (const key of required) {
    it.each(['missing', 'invalid', 'foreign', 'local', 'nonexistent', 'foreign-bucket'])(`${key}: %s blocks ordinary approval`, async (kind) => {
      const field = DRIVER_DOCUMENT_DEFINITIONS[key].field;
      alter(uid, { [field]: kind === 'missing' ? null : kind === 'invalid' ? 'https://example.com/file'
        : kind === 'foreign' ? url(key, 'other') : kind === 'local' ? 'file:///tmp/image.jpg'
        : kind === 'foreign-bucket' ? url(key, uid, 'other.firebasestorage.app') : url(key) });
      if (kind === 'nonexistent') mocks.getMetadata.mockImplementation(async (_bucket, path) => {
        if (path.endsWith(`/${key}.jpg`)) throw { code: 404 }; return metadata;
      });
      const result = await decision(); expect(result.status).toBe(422);
      expect(result.body.missingDocuments).toEqual([key]); expect(committed).toBe(0);
    });
  }
  it.each(['absent', 'valid', 'invalid'])('insurance and roadworthy are optional when %s', async (kind) => {
    if (kind !== 'absent') alter(uid, { insurance_url: kind === 'valid' ? url('insurance') : 'file:///insurance',
      roadworthy_url: kind === 'valid' ? url('roadworthy') : url('roadworthy', 'foreign') });
    const result = await decision(); expect(result.status).toBe(200); expect(profile().approval_status).toBe('approved');
  });
  it.each([{ ...metadata, contentType: 'application/pdf' }, { ...metadata, size: 0 },
    { ...metadata, size: DRIVER_DOCUMENT_MAX_BYTES + 1 }, { ...metadata, metadata: { firebaseStorageDownloadTokens: 'revoked' } }])('unusable MIME/size/token prevents approval %#', async (bad) => {
    mocks.getMetadata.mockResolvedValue(bad);
    expect((await decision()).status).toBe(422); expect(committed).toBe(0);
  });
  it('unknown Storage state is 503, never missing-document success', async () => {
    mocks.getMetadata.mockRejectedValue({ code: 403 });
    const result = await review(); expect(result.status).toBe(503); expect(result.body.code).toBe('DOCUMENT_STORAGE_UNAVAILABLE');
  });
  it('unconfirmable Storage generation is 503 and does not approve or report files as absent', async () => {
    mocks.getMetadata.mockResolvedValue({ ...metadata, generation: undefined });
    const result = await review(); expect(result.status).toBe(503);
    expect(result.body.code).toBe('DOCUMENT_STORAGE_UNAVAILABLE'); expect(result.body.manifest).toBeUndefined();
    expect(committed).toBe(0);
  });
});

describe('exact reviewed revision is mandatory for every decision', () => {
  it.each([undefined, null, '', 'verified', true, { approved: true }])('malformed approval status is rejected %#', async (approvalStatus) => {
    const result = await decide({ approvalStatus, documentRevision: 'a'.repeat(64) });
    expect(result.status).toBe(400); expect(result.body.code).toBe('DRIVER_APPROVAL_INVALID');
    expect(mocks.getMetadata).not.toHaveBeenCalled(); expect(committed).toBe(0);
  });
  it.each(['approved', 'rejected', 'pending'])('rejects missing, malformed and stale version for %s', async (approvalStatus) => {
    for (const [documentRevision, code] of [[undefined, 'DOCUMENT_REVISION_REQUIRED'], [null, 'DOCUMENT_REVISION_REQUIRED'],
      ['', 'DOCUMENT_REVISION_REQUIRED'], ['x', 'DOCUMENT_REVISION_INVALID'], [42, 'DOCUMENT_REVISION_INVALID'],
      ['a'.repeat(64) + ' ', 'DOCUMENT_REVISION_INVALID'], ['a'.repeat(64), 'DOCUMENT_REVISION_STALE']] as const) {
      const result = await decide({ approvalStatus, reason: 'Review reason', documentRevision });
      expect(result.status).toBe(409); expect(result.body.code).toBe(code); expect(committed).toBe(0);
    }
  });
  it.each(['reference', 'details', 'status', 'version', 'alias-version', 'alias-owner', 'generation', 'token', 'additional-token', 'metageneration', 'size', 'mime', 'owner'])('detects %s changes after GET', async (kind) => {
    put('legacy', { user_id: uid, approved: true });
    const loaded = await review();
    if (kind === 'reference') alter(uid, { ghana_card_front_url: url('changed') });
    if (kind === 'details') alter(uid, { vehicle_make: 'Changed' });
    if (kind === 'status') alter(uid, { approval_status: 'rejected' });
    if (kind === 'version') alter(uid, {});
    if (kind === 'alias-version') alter('legacy', {});
    if (kind === 'alias-owner') alter('legacy', { user_id: 'other' });
    if (kind === 'owner') alter(uid, { user_id: 'other' });
    if (kind === 'generation') mocks.getMetadata.mockResolvedValue({ ...metadata, generation: '124' });
    if (kind === 'token') mocks.getMetadata.mockResolvedValue({ ...metadata, metadata: { firebaseStorageDownloadTokens: 'new-token' } });
    if (kind === 'additional-token') mocks.getMetadata.mockResolvedValue({ ...metadata, metadata: { firebaseStorageDownloadTokens: 'test-token,new-token' } });
    if (kind === 'metageneration') mocks.getMetadata.mockResolvedValue({ ...metadata, metageneration: '2' });
    if (kind === 'size') mocks.getMetadata.mockResolvedValue({ ...metadata, size: '2048' });
    if (kind === 'mime') mocks.getMetadata.mockResolvedValue({ ...metadata, contentType: 'image/png' });
    const result = await decide({ approvalStatus: 'approved', documentRevision: loaded.body.manifest.documentRevision });
    expect(result.status).toBe(kind === 'owner' ? 403 : 409); expect(committed).toBe(0);
  });
  it.each(['approved', 'rejected', 'pending'])('binds stale Storage generation for %s, not only approval', async (approvalStatus) => {
    const loaded = await review(); mocks.getMetadata.mockResolvedValue({ ...metadata, generation: '999' });
    expect((await decide({ approvalStatus, reason: 'Review reason', documentRevision: loaded.body.manifest.documentRevision })).body.code).toBe('DOCUMENT_REVISION_STALE');
  });
});

describe('concurrent Firestore and late Storage decision revalidation', () => {
  it.each(['canonical-version', 'alias-owner', 'canonical-appearance'])('rejects %s between preflight and transaction', async (kind) => {
    put('legacy', { user_id: uid, ...documents() });
    if (kind === 'canonical-appearance') store.delete(`driver_profiles/${uid}`);
    const loaded = await review();
    beforeTransaction = () => kind === 'canonical-version' ? alter(uid, {})
      : kind === 'alias-owner' ? alter('legacy', { user_id: 'other' }) : put(uid, { user_id: uid, ...documents() });
    const result = await decide({ approvalStatus: 'approved', documentRevision: loaded.body.manifest.documentRevision });
    expect(result.status).toBe(409); expect(committed).toBe(0);
  });
  it('detects Firestore update during GET metadata reads', async () => {
    let done = false;
    mocks.getMetadata.mockImplementation(async () => { if (!done) { alter(uid, { vehicle_color: 'Blue' }); done = true; } return metadata; });
    expect((await review()).body.code).toBe('DOCUMENT_REVISION_STALE'); expect(committed).toBe(0);
  });
  it('transaction retries reject Firestore update during late metadata reads rather than auto-reviewing new data', async () => {
    const loaded = await review(); let changed = false;
    mocks.getMetadata.mockImplementation(async () => {
      if (attempts === 1 && !changed) { alter(uid, { full_name: 'Changed during check' }); changed = true; } return metadata;
    });
    const result = await decide({ approvalStatus: 'approved', documentRevision: loaded.body.manifest.documentRevision });
    expect(result.status).toBe(409); expect(attempts).toBe(2); expect(committed).toBe(0); expect(events()).toHaveLength(0);
  });
  it('transaction retry detects an added approved alias', async () => {
    const loaded = await review(); beforeCommit = () => put('new-alias', { user_id: uid, approved: true });
    const result = await decide({ approvalStatus: 'rejected', reason: 'Invalid documents', documentRevision: loaded.body.manifest.documentRevision });
    expect(result.status).toBe(409); expect(attempts).toBe(2); expect(committed).toBe(0);
  });
  it('a presence-only retry rechecks Storage and commits exactly one immutable audit event', async () => {
    put(uid, { user_id: uid, approval_status: 'approved', ...documents() });
    put(uid, { user_id: uid, is_online: true }, 'driver_presence');
    const loaded = await review(); beforeCommit = () => alter(uid, { last_seen: 'new heartbeat' }, 'driver_presence');
    const result = await decide({ approvalStatus: 'pending', documentRevision: loaded.body.manifest.documentRevision });
    expect(result.status).toBe(200); expect(attempts).toBe(2); expect(committed).toBe(1); expect(events()).toHaveLength(1);
    expect(mocks.getMetadata).toHaveBeenCalledTimes(24); // One GET, one preflight and two transaction attempts, each six files.
  });
  it('same URL generation replacement immediately before transaction check is stale', async () => {
    const loaded = await review(); beforeTransaction = () => mocks.getMetadata.mockResolvedValue({ ...metadata, generation: '456' });
    expect((await decide({ approvalStatus: 'approved', documentRevision: loaded.body.manifest.documentRevision })).body.code).toBe('DOCUMENT_REVISION_STALE');
    expect(committed).toBe(0);
  });
  it.each(['approved', 'rejected', 'pending'])('never produces partial %s profile/presence/audit writes on injected commit failure', async (status) => {
    put('alias', { user_id: uid, approved: true }); put(uid, { user_id: uid, is_online: true }, 'driver_presence');
    const before = structuredClone(store); failCommit = true;
    expect((await decision(status, { reason: 'Reviewed documents' })).status).toBe(503);
    expect(store).toEqual(before); expect(events()).toHaveLength(0); expect(committed).toBe(0); noSideEffects();
  });
  it('confirmed response does not depend on an unreliable post-commit read', async () => {
    const loaded = await review(); beforeCommit = () => { readHook = () => { throw new Error('read unavailable after commit'); }; };
    const result = await decide({ approvalStatus: 'approved', documentRevision: loaded.body.manifest.documentRevision });
    expect(result.status).toBe(200); expect(result.body.account.approvalStatus).toBe('approved'); expect(committed).toBe(1);
    expect(result.body.manifest).toBeUndefined(); expect(result.body.documentRevision).toBe(loaded.body.manifest.documentRevision);
  });
});

describe('trusted supervised Test Driver exception and narrow lifecycle writes', () => {
  it.each([undefined, false, 'true', 1])('does not trust client classification or non-boolean persisted flag %#', async (flag) => {
    put(uid, { user_id: uid, is_test_driver: flag });
    const result = await decision('approved', { isTestDriver: true, is_test_driver: true });
    expect(result.status).toBe(422); expect(profile().is_test_driver).toBe(flag); expect(committed).toBe(0);
  });
  it('allows only explicitly server-selected exact boolean test classification and audits supervised_test exception', async () => {
    put(uid, { user_id: uid, is_test_driver: true, account_status: 'inactive' });
    const result = await decision(); expect(result.status).toBe(200);
    expect(result.body.account).toMatchObject({ isTestDriver: true, approvalStatus: 'approved', accountStatus: 'inactive' });
    expect(events()[0]).toMatchObject({ exception: 'supervised_test', actor_type: 'administrator', actor_id: admin, missing_documents: required });
    expect(profile().is_test_driver).toBe(true); noSideEffects();
  });
  it('approval synchronizes every same-UID record and all approval aliases without relabeling test classification', async () => {
    put('legacy', { user_id: uid, approval_status: 'rejected', status: 'pending', is_test_driver: true });
    const result = await decision('approved', { reason: 'Application checked' });
    expect(result.status).toBe(200);
    for (const id of [uid, 'legacy']) expect(profile(id)).toMatchObject({ approval_status: 'approved', application_status: 'approved', approved: true, is_approved: true });
    expect(profile('legacy').status).toBe('approved'); expect(profile('legacy').is_test_driver).toBe(true);
    expect(profile().is_test_driver).toBeUndefined(); expect(events()[0].exception).toBeNull();
  });
  it.each(['rejected', 'pending'])('%s is permitted on an incomplete ordinary application with exact reviewed revision', async (status) => {
    put(uid, { user_id: uid, approval_status: 'pending' });
    expect((await decision(status, { reason: 'No supporting documents' })).status).toBe(200);
    expect(profile().approval_status).toBe(status); expect(events()[0].missing_documents).toEqual(required);
  });
  it.each(['inactive', 'suspended'])('approval preserves %s lifecycle, wallet, fees, payment and test flag', async (status) => {
    alter(uid, { account_status: status, status, driver_fee_bypass: { allowed: true }, payment_status: 'unpaid', wallet_balance: 50, is_test_driver: false });
    const result = await decision(); expect(result.status).toBe(200);
    expect(profile()).toMatchObject({ account_status: status, status, driver_fee_bypass: { allowed: true }, payment_status: 'unpaid', wallet_balance: 50, is_test_driver: false });
    noSideEffects();
  });
  it.each(['rejected', 'pending'])('%s atomically synchronizes aliases, clears presence and records decision history', async (status) => {
    put(uid, { user_id: uid, approval_status: 'approved', approved: true, is_approved: true, is_online: true, ...documents() });
    put('legacy', { user_id: uid, approval_status: 'approved', application_status: 'approved', status: 'approved', approved: true, is_approved: true, is_available: true });
    put(uid, { user_id: uid, is_online: true, is_available: true, account_status: 'suspended', latitude: 5 }, 'driver_presence');
    const result = await decision(status, { reason: '  Documents   unreadable  ' });
    expect(result.status).toBe(200);
    for (const id of [uid, 'legacy']) expect(profile(id)).toMatchObject({ approval_status: status, application_status: status,
      approved: false, is_approved: false, is_online: false, is_available: false, availability_status: 'offline' });
    expect(profile('legacy').status).toBe(status);
    expect(store.get(`driver_presence/${uid}`)!.data).toMatchObject({ is_online: false, is_available: false,
      approved: false, is_approved: false, approval_status: status, account_status: 'suspended', latitude: 5 });
    expect(events()[0]).toMatchObject({ action: 'driver_approval_decided', actor_type: 'administrator', actor_id: admin,
      previous_approval_status: 'approved', new_approval_status: status, decision_reason: 'Documents unreadable' });
    expect(events()[0].reviewed_document_revision).toMatch(/^[a-f0-9]{64}$/);
    expect(events()[0].created_date).toBeTruthy(); expect(events()[0].linked_profiles).toHaveLength(2);
    expect(result.body.account.rejectionReason).toBe(status === 'rejected' ? 'Documents unreadable' : null);
    const history = await http(`/api/admin/accounts/${uid}/lifecycle?role=driver`);
    expect(history.body.events[0]).toMatchObject({ newApprovalStatus: status, decisionReason: 'Documents unreadable', reviewedDocumentRevision: events()[0].reviewed_document_revision });
    noSideEffects();
  });
  it.each([undefined, null, '', '   ', 12, 'no', 'x'.repeat(501)])('rejection requires a trimmed bounded reason %#', async (reason) => {
    const result = await decision('rejected', { reason }); expect(result.status).toBe(400);
    expect(result.body.code).toBe('DRIVER_REJECTION_REASON_REQUIRED'); expect(committed).toBe(0);
  });
  it('accepts 500 characters after trimming, clears old reason on pending and never overwrites audit events', async () => {
    expect((await decision('rejected', { reason: `  ${'x'.repeat(500)}  ` })).status).toBe(200);
    const first = structuredClone(events()[0]);
    expect((await decision('pending')).status).toBe(200); expect(profile().rejection_reason).toBeNull();
    expect(events()).toHaveLength(2); expect(events()[0]).toEqual(first);
  });
  it('rejects foreign presence ownership without relabeling another account', async () => {
    put(uid, { user_id: 'other', is_online: true }, 'driver_presence');
    expect((await decision('rejected', { reason: 'Unreadable documents' })).status).toBe(403); expect(committed).toBe(0);
  });
});
