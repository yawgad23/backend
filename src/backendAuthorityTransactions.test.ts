import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ db: null as any, verify: vi.fn(), claim: vi.fn(), get: vi.fn(), list: vi.fn(), set: vi.fn() }));
vi.mock('./firebaseAdmin', () => ({ ADMIN_COLLECTIONS: { DRIVER_PROFILES: 'driver_profiles', RIDER_PROFILES: 'rider_profiles' },
  getAdminDb: () => mocks.db, getAdminAuth: () => ({ verifyIdToken: mocks.verify }), adminFirestore: mocks }));
vi.mock('./accountContactClaims', async (original) => ({ ...(await original<typeof import('./accountContactClaims')>()), claimAccountContacts: mocks.claim }));
vi.mock('./driverDocumentManifestRead', () => ({ readDriverDocumentManifest: vi.fn() }));
import { registerAccountProfileRoutes, saveDriverApplication } from './accountProfileRoutes';
import { registerDriverPhoneLoginRoutes } from './driverPhoneLogin';
import { DRIVER_DOCUMENT_DEFINITIONS, driverDocumentKeys } from './driverDocumentManifest';

const uid = 'own-uid';
const phone = '+233241220725';
const url = (key: string) => `https://firebasestorage.googleapis.com/v0/b/hy3n26.firebasestorage.app/o/${encodeURIComponent(`drivers/${uid}/${key}.jpg`)}?alt=media&token=test`;
const documents = Object.fromEntries(driverDocumentKeys.map((key) => [key, url(key)]));
const input = { fullName: 'Kofi Mensah', email: 'owner@example.com', phone, momoNumber: phone, city: 'Accra', serviceType: 'car',
  rideCategories: ['standard', 'comfort'], vehicleMake: 'Toyota', vehicleModel: 'Corolla', vehiclePlate: 'GW-123-26', vehicleColor: 'Blue', vehicleYear: '2020', documents };
const material = { full_name: input.fullName, email: input.email, phone, momo_number: phone, city: input.city, service_type: input.serviceType,
  accepted_categories: input.rideCategories, ride_categories: input.rideCategories, vehicle_make: input.vehicleMake, vehicle_model: input.vehicleModel,
  vehicle_plate: input.vehiclePlate, license_plate: input.vehiclePlate, vehicle_color: input.vehicleColor, vehicle_colour: input.vehicleColor,
  vehicle_year: input.vehicleYear, ...Object.fromEntries(driverDocumentKeys.map((key) => [DRIVER_DOCUMENT_DEFINITIONS[key].field, documents[key]])) };
type Item = { data: Record<string, any>; version: number };
type Ref = { collection: string; id: string };
type Query = { collection: string; field: string; value: string; cap: number };
let store: Map<string, Item>;
let nextId: number;
let attempts: number;
let failCommit: boolean;
let beforeTransaction: (() => void) | null;
let beforeCommit: (() => void) | null;
const path = (ref: Ref) => `${ref.collection}/${ref.id}`;
function put(id: string, data: Record<string, any>, collection = 'driver_profiles') {
  const key = `${collection}/${id}`;
  store.set(key, { data: structuredClone(data), version: (store.get(key)?.version || 0) + 1 });
}
function alter(id: string, patch: Record<string, any>, collection = 'driver_profiles') { put(id, { ...record(id, collection), ...patch }, collection); }
function record(id = uid, collection = 'driver_profiles') { return store.get(`${collection}/${id}`)?.data; }
function snapshot(ref: Ref, view = store): any {
  const item = view.get(path(ref));
  return { id: ref.id, exists: Boolean(item), data: () => structuredClone(item?.data) };
}
function queryDocs(q: Query, view = store): any[] {
  return [...view.entries()].filter(([key, item]) => key.startsWith(`${q.collection}/`) && item.data[q.field] === q.value)
    .sort(([a], [b]) => a.localeCompare(b)).slice(0, q.cap).map(([key]) => snapshot({ collection: q.collection, id: key.split('/')[1] }, view));
}
function query(collection: string, field: string, value: string, cap = 100): any {
  const q = { collection, field, value, cap };
  return { ...q, orderBy: () => query(collection, field, value, cap), limit: (limit: number) => query(collection, field, value, limit),
    get: async () => ({ docs: queryDocs(q) }) };
}
function collection(name: string): any {
  return { doc: (id = `event-${++nextId}`) => ({ collection: name, id, get: async () => snapshot({ collection: name, id }) }),
    where: (field: string, operation: string, value: string) => { expect(operation).toBe('=='); return query(name, field, value); } };
}
async function runTransaction(callback: (tx: any) => Promise<any>) {
  beforeTransaction?.(); beforeTransaction = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    attempts++;
    const view = structuredClone(store);
    const reads = new Map<string, number | undefined>();
    const queries: Query[] = [];
    const writes: Array<{ ref: Ref; data: Record<string, any>; create?: boolean }> = [];
    const tx = { get: async (ref: Ref | Query) => {
      expect(writes).toHaveLength(0);
      if ('field' in ref) {
        queries.push(ref);
        const docs = queryDocs(ref, view);
        for (const doc of docs) reads.set(`${ref.collection}/${doc.id}`, view.get(`${ref.collection}/${doc.id}`)?.version);
        return { docs };
      }
      reads.set(path(ref), view.get(path(ref))?.version);
      return snapshot(ref, view);
    }, set: (ref: Ref, data: any, options: any) => { expect(options).toEqual({ merge: true }); writes.push({ ref, data }); },
    create: (ref: Ref, data: any) => writes.push({ ref, data, create: true }) };
    const result = await callback(tx);
    beforeCommit?.(); beforeCommit = null;
    const signature = (q: Query, source: Map<string, Item>) => JSON.stringify(queryDocs(q, source).map((d) => [d.id, source.get(`${q.collection}/${d.id}`)?.version]));
    if ([...reads].some(([key, version]) => store.get(key)?.version !== version)
      || queries.some((q) => signature(q, store) !== signature(q, view))) continue;
    if (failCommit) throw new Error('injected commit failure');
    const next = structuredClone(store);
    for (const write of writes) {
      if (write.create && next.has(path(write.ref))) throw new Error('event collision');
      const prior = next.get(path(write.ref));
      next.set(path(write.ref), { data: { ...prior?.data, ...structuredClone(write.data) }, version: (prior?.version || 0) + 1 });
    }
    store = next;
    return result;
  }
  throw new Error('contention limit');
}
let server: ReturnType<ReturnType<typeof express>['listen']>;
let origin: string;
beforeAll(async () => {
  const app = express(); app.use(express.json()); registerAccountProfileRoutes(app); registerDriverPhoneLoginRoutes(app);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
beforeEach(() => {
  vi.clearAllMocks(); store = new Map(); nextId = attempts = 0; failCommit = false; beforeTransaction = beforeCommit = null;
  mocks.db = { collection, runTransaction }; mocks.claim.mockResolvedValue(undefined);
  mocks.verify.mockResolvedValue({ uid, email: input.email, phone_number: phone });
  mocks.get.mockImplementation(async (name, id) => { const value = record(id, name); return value ? { ...value, id } : null; });
  mocks.list.mockImplementation(async (name, filters, _order, _direction, limit) => {
    const [field, value] = Object.entries(filters)[0];
    return queryDocs({ collection: name, field, value: String(value), cap: limit || 100 }).map((doc) => ({ ...doc.data(), id: doc.id }));
  });
});
async function post(route = '/api/account/profile/driver', body: any = input) {
  const response = await fetch(`${origin}${route}`, { method: 'POST', headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}
function approved(extra: Record<string, any> = {}, id = uid) {
  put(id, { ...material, user_id: uid, approval_status: 'approved', application_status: 'approved', approved: true, is_approved: true,
    account_status: 'active', approval_updated_at: 'admin-decision', approval_updated_by: 'admin', is_online: true, is_available: true,
    availability_status: 'online', total_rides: 42, wallet_balance: 700, is_test_driver: false, ...extra });
  put(uid, { user_id: uid, approval_status: 'approved', approved: true, is_online: true, is_available: true, availability_status: 'online', active_ride_id: 'live-trip' }, 'driver_presence');
}
function events() { return [...store.entries()].filter(([key]) => key.startsWith('account_lifecycle_events/')).map(([, item]) => item.data); }
function pendingAliases() {
  expect(record()).toMatchObject({ approval_status: 'pending', application_status: 'pending', approved: false, is_approved: false,
    is_online: false, is_available: false, availability_status: 'offline', rejection_reason: null });
  expect(record(uid, 'driver_presence')).toMatchObject({ approval_status: 'pending', approved: false, is_approved: false, is_online: false, is_available: false });
}

describe('transactional manual Driver application submission', () => {
  it('new complete registration is pending/offline and ignores client approval/test flags', async () => {
    expect((await post(undefined, { ...input, approval_status: 'approved', approved: true, is_test_driver: true })).status).toBe(200);
    pendingAliases(); expect(record()?.is_test_driver).toBeUndefined(); expect(events()).toHaveLength(1);
    expect(record()).toMatchObject({ vehicle_photo_url: documents.vehiclePhoto, account_status: 'active' });
    expect(record()?.vehicle_registration_url).toBeUndefined(); expect(mocks.set).not.toHaveBeenCalled();
  });
  it('identical approved resend preserves approval, admin metadata and live availability/counters', async () => {
    approved(); const beforePresence = structuredClone(record(uid, 'driver_presence'));
    expect((await post()).status).toBe(200);
    expect(record()).toMatchObject({ approval_status: 'approved', approved: true, is_online: true, approval_updated_at: 'admin-decision',
      approval_updated_by: 'admin', total_rides: 42, wallet_balance: 700, is_test_driver: false });
    expect(record(uid, 'driver_presence')).toEqual(beforePresence); expect(events()[0].material_changed).toBe(false);
  });
  it('normalization/category ordering and payout-only changes do not revoke unchanged approval', async () => {
    approved();
    expect((await post(undefined, { ...input, fullName: 'Kofi  Mensah', phone: '0241220725', momoNumber: '0241220726', rideCategories: ['comfort', 'standard'] })).status).toBe(200);
    expect(record()?.approval_status).toBe('approved');
  });
  it.each([
    ['identity', { fullName: 'Kofi Different' }], ['vehicle', { vehiclePlate: 'GW-999-26' }], ['vehicle model', { vehicleModel: 'Camry' }],
    ['service', { serviceType: 'delivery' }], ['category expansion', { rideCategories: ['standard', 'comfort', 'executive'] }],
    ['required document', { documents: { ...documents, ghanaCardFront: url('replacement') } }],
    ['optional document', { documents: { ...documents, insurance: '' } }],
    ['vehicle photo', { documents: { ...documents, vehiclePhoto: url('new-vehicle-photo') } }],
  ])('changed %s awaits manual approval and synchronizes aliases without touching trip records', async (_label, change) => {
    approved({ status: 'approved' }); approved({ status: 'approved' }, 'legacy'); put('live-trip', { driver_id: uid, status: 'in_progress' }, 'rides');
    expect((await post(undefined, { ...input, ...change })).status).toBe(200); pendingAliases();
    expect(record('legacy')).toMatchObject({ approval_status: 'pending', approved: false, status: 'pending' });
    expect(record(uid, 'driver_presence')?.active_ride_id).toBe('live-trip'); expect(record('live-trip', 'rides')?.status).toBe('in_progress');
    expect(record()?.total_rides).toBe(42);
  });
  it('rejected resubmit clears stale aliases/reason and stays pending with login enabled', async () => {
    approved({ approval_status: 'rejected', application_status: 'rejected', status: 'rejected', rejection_reason: 'old reason' });
    expect((await post()).status).toBe(200); pendingAliases(); expect(record()?.status).toBe('pending');
    expect(mocks.verify).toHaveBeenCalledWith('valid', true);
  });
  it.each(['suspended', 'inactive'])('never reactivates %s on submission', async (accountStatus) => {
    approved({ account_status: accountStatus, account_status_updated_by: 'admin' });
    expect((await post()).status).toBe(200);
    expect(record()).toMatchObject({ account_status: accountStatus, account_status_updated_by: 'admin', is_online: false });
    expect(record(uid, 'driver_presence')).toMatchObject({ is_online: false, account_status: accountStatus });
  });
  it('legacy photo alias for the known filename can be resent unchanged and writes canonical photo field', async () => {
    approved({ vehicle_photo_url: '', vehicle_registration_url: url('vehicle-photo') });
    expect((await post(undefined, { ...input, documents: { ...documents, vehiclePhoto: url('vehicle-photo') } })).status).toBe(200);
    expect(record()).toMatchObject({ approval_status: 'approved', vehicle_photo_url: url('vehicle-photo'), vehicle_registration_url: url('vehicle-photo') });
  });
  it('partial UID presence stub plus unchanged approved legacy is not blanket-revoked', async () => {
    approved({}, 'legacy'); put(uid, { user_id: uid, is_online: true, vehicle_make: 'Toyota' });
    expect((await post()).status).toBe(200); expect(record()?.approval_status).toBe('approved'); expect(record('legacy')?.approval_status).toBe('approved');
  });
  it('changed protected contact identity requeues rather than bypassing submission review', async () => {
    approved(); await saveDriverApplication(uid, { full_name: 'Changed Identity', email: input.email, phone }, false); pendingAliases();
  });
  it.each(['approved', 'rejected'])('a concurrent admin %s before transaction cannot be overwritten by stale registration', async (decision) => {
    approved({ approval_status: 'pending' });
    beforeTransaction = () => alter(uid, { approval_status: decision, application_status: decision, approval_updated_at: 'new-admin-decision' });
    expect((await post(undefined, { ...input, vehiclePlate: 'new-plate' })).status).toBe(400);
    expect(record()?.approval_status).toBe(decision); expect(record()?.vehicle_plate).toBe(input.vehiclePlate); expect(events()).toHaveLength(0);
  });
  it('rejection during commit causes retry and stale submission refusal with no application/presence writes', async () => {
    approved(); beforeCommit = () => alter(uid, { approval_status: 'rejected', approval_updated_at: 'new-admin-decision' });
    expect((await post()).status).toBe(400); expect(attempts).toBe(2); expect(record()?.approval_status).toBe('rejected'); expect(events()).toHaveLength(0);
  });
  it('ordinary heartbeat contention retries without revoking unchanged approval', async () => {
    approved(); beforeCommit = () => alter(uid, { updated_date: 'heartbeat', current_lat: 5 });
    expect((await post()).status).toBe(200); expect(attempts).toBe(2); expect(record()?.approval_status).toBe('approved'); expect(record()?.current_lat).toBe(5);
  });
  it('failed commit leaves profile aliases/presence/audit atomically unchanged', async () => {
    approved(); const before = structuredClone(store); failCommit = true;
    expect((await post(undefined, { ...input, vehiclePlate: 'new-plate' })).status).toBe(400); expect(store).toEqual(before);
  });
});

describe('phone linking uses the same transactional authority', () => {
  const route = '/api/driver/phone-login/link';
  it.each(['pending', 'rejected'])('canonical %s beats stale approved alias and still permits phone login', async (state) => {
    approved({}, 'legacy'); put(uid, { ...material, user_id: uid, approval_status: state, approved: true, rejection_reason: 'Needs review' });
    const result = await post(route, { approved: true }); expect(result.status).toBe(200); expect(result.body.approvalStatus).toBe(state);
    expect(record()).toMatchObject({ approval_status: state, approved: false, is_online: false }); expect(record('legacy')?.approval_status).toBe(state);
    expect(mocks.verify).toHaveBeenCalledWith('valid', true);
  });
  it('current-profile read returns canonical pending rather than newer approved alias', async () => {
    approved({ updated_date: '2030' }, 'legacy'); put(uid, { user_id: uid, approval_status: 'pending', updated_date: '2020' });
    const response = await fetch(`${origin}/api/driver/profile/current`, { headers: { Authorization: 'Bearer valid' } });
    expect(response.status).toBe(200); expect((await response.json() as any).profile.approval_status).toBe('pending');
  });
  it('different-owner phone collisions do not write or choose approval-first', async () => {
    approved(); put('foreign', { ...material, user_id: 'other', approval_status: 'approved' }); const before = structuredClone(store);
    expect((await post(route)).status).toBe(409); expect(store).toEqual(before); expect(mocks.claim).not.toHaveBeenCalled();
  });
  it('a destination canonical pending application survives transfer of an approved old owner alias', async () => {
    put('old-uid', { ...material, user_id: 'old-uid', approval_status: 'approved' });
    put(uid, { ...material, user_id: uid, phone: '', phone_number: '', approval_status: 'pending' });
    // A pending canonical must match the verified phone to permit linking; unrelated targets never get replaced.
    expect((await post(route)).status).toBe(503); expect(record()?.approval_status).toBe('pending');
  });
  it('approved legacy with UID-only stub links unchanged without approval reset', async () => {
    approved({}, 'legacy'); put(uid, { user_id: uid, is_online: false });
    expect((await post(route)).body.approvalStatus).toBe('approved'); expect(record()?.approval_status).toBe('approved');
  });
  it('legacy owner transfer preserves approval but moves profiles offline, never assigns trips', async () => {
    put('old-uid', { ...material, user_id: 'old-uid', approval_status: 'approved', is_online: true });
    expect((await post(route)).status).toBe(200);
    expect(record()).toMatchObject({ user_id: uid, approval_status: 'approved', is_online: false }); expect(record('old-uid')?.user_id).toBe(uid);
  });
  it.each(['suspended', 'inactive'])('phone linking never reactivates a %s destination stub', async (state) => {
    put('old-uid', { ...material, user_id: 'old-uid', approval_status: 'approved', account_status: 'active' });
    put(uid, { user_id: uid, status: state, account_status_updated_by: 'admin' });
    expect((await post(route)).status).toBe(200);
    expect(record()).toMatchObject({ account_status: state, account_status_updated_by: 'admin', is_online: false });
    expect(record(uid, 'driver_presence')).toMatchObject({ account_status: state, is_online: false });
  });
  it('legacy suspension is preserved when phone linking creates the UID canonical', async () => {
    put('old-uid', { ...material, user_id: 'old-uid', approved: true, status: 'suspended' });
    expect((await post(route)).status).toBe(200);
    expect(record()).toMatchObject({ status: 'suspended', account_status: 'suspended', is_online: false });
  });
  it('admin rejection racing phone link cannot be overwritten', async () => {
    approved(); beforeCommit = () => alter(uid, { approval_status: 'rejected', approval_updated_at: 'latest-decision' });
    expect((await post(route)).status).toBe(503); expect(record()?.approval_status).toBe('rejected'); expect(attempts).toBe(2);
  });
  it('phone link commit failure has no partial alias/presence update', async () => {
    approved({}, 'legacy'); put(uid, { ...material, user_id: uid, approval_status: 'pending' }); const before = structuredClone(store); failCommit = true;
    expect((await post(route)).status).toBe(503); expect(store).toEqual(before);
  });
});
