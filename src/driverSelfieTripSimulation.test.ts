import { mkdirSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import superjson from 'superjson';

// Install the deny-all external fetch mock BEFORE production imports. Only the
// guarded localHttp helper below may use the captured native fetch.
const harness = vi.hoisted(() => {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const externalFetch = vi.fn(async () => { throw new Error('External fetch is forbidden in the synthetic simulation.'); });
  vi.stubGlobal('fetch', externalFetch);
  return {
    nativeFetch, externalFetch,
    records: new Map<string, Record<string, any>>(),
    writes: [] as Array<{ key: string; data: Record<string, any>; source: string }>,
    reads: [] as string[],
    transactions: 0,
    nextEvent: 0,
    verifyIdToken: vi.fn(),
    forbiddenAuth: vi.fn(async () => { throw new Error('Real Firebase Auth operations are forbidden.'); }),
    forbiddenStorage: vi.fn(() => { throw new Error('Real Firebase Storage operations are forbidden.'); }),
    forbiddenMessaging: vi.fn(() => { throw new Error('Real Firebase Messaging operations are forbidden.'); }),
    forbiddenEmail: vi.fn(async () => { throw new Error('Email delivery is forbidden.'); }),
    liveActivity: vi.fn(async () => ({})),
    routeRefresh: vi.fn(async () => ({})),
  };
});

vi.mock('./firebaseAdmin', () => {
  const snapshot = (key: string) => {
    const value = harness.records.get(key);
    return { id: key.split('/').at(-1)!, exists: Boolean(value), data: () => value ? structuredClone(value) : undefined };
  };
  const list = (name: string, filters: Record<string, any> = {}, maximum = Infinity) => [...harness.records.entries()]
    .filter(([key, data]) => key.startsWith(`${name}/`) && Object.entries(filters).every(([field, value]) => data[field] === value))
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, maximum)
    .map(([key, data]) => ({ ...structuredClone(data), id: key.split('/').at(-1)! }));
  const persist = (key: string, data: Record<string, any>, source: string) => {
    harness.writes.push({ key, data: structuredClone(data), source });
    const saved = { ...harness.records.get(key), ...structuredClone(data) };
    harness.records.set(key, saved);
    return { ...structuredClone(saved), id: key.split('/').at(-1)! };
  };
  const collection = (name: string) => {
    const query: any = {
      name, filters: [] as Array<[string, any]>, maximum: Infinity,
      where(field: string, operator: string, value: any) {
        if (operator !== '==') throw new Error(`Unsupported synthetic query operator: ${operator}`);
        return { ...this, filters: [...this.filters, [field, value]] };
      },
      orderBy() { return this; },
      limit(maximum: number) { return { ...this, maximum }; },
      doc(id: string) { return { key: `${name}/${id}`, get: async () => snapshot(`${name}/${id}`) }; },
      async get() {
        return { docs: list(name, Object.fromEntries(this.filters), this.maximum).map((data) => snapshot(`${name}/${data.id}`)) };
      },
    };
    return query;
  };
  return {
    ADMIN_COLLECTIONS: {
      DRIVER_PROFILES: 'driver_profiles', RIDER_PROFILES: 'rider_profiles', RIDES: 'rides',
      RIDE_EVENTS: 'ride_events', PUSH_DEVICES: 'push_devices', DAILY_COMMISSION: 'daily_commissions',
      RIDE_REPORTS: 'ride_reports', SOS_INCIDENTS: 'sos_incidents',
    },
    getAdminApp: harness.forbiddenAuth,
    getAdminAuth: () => ({ verifyIdToken: harness.verifyIdToken, getUser: harness.forbiddenAuth }),
    getAdminDb: () => ({
      collection,
      async runTransaction(callback: (transaction: any) => Promise<any>) {
        harness.transactions++;
        const pending: Array<{ key: string; data: Record<string, any> }> = [];
        const result = await callback({
          async get(ref: any) {
            if (pending.length) throw new Error('Transaction reads must precede writes.');
            if (ref.key) { harness.reads.push(ref.key); return snapshot(ref.key); }
            harness.reads.push(`${ref.name}/query`);
            return { docs: list(ref.name, Object.fromEntries(ref.filters), ref.maximum)
              .map((data) => snapshot(`${ref.name}/${data.id}`)) };
          },
          update(ref: any, data: Record<string, any>) { pending.push({ key: ref.key, data }); },
          set(ref: any, data: Record<string, any>) { pending.push({ key: ref.key, data }); },
        });
        // Atomic test-store commit only after the real callback succeeds.
        for (const write of pending) persist(write.key, write.data, 'transaction');
        return result;
      },
    }),
    adminFirestore: {
      get: vi.fn(async (name: string, id: string) => {
        const key = `${name}/${id}`;
        harness.reads.push(key);
        const value = harness.records.get(key);
        return value ? { ...structuredClone(value), id } : null;
      }),
      list: vi.fn(async (name: string, filters: Record<string, any> = {}, _order?: any, _direction?: any, maximum?: number) =>
        list(name, filters, maximum)),
      create: vi.fn(async (name: string, data: Record<string, any>) => persist(`${name}/synthetic-event-${++harness.nextEvent}`, data, 'create')),
      update: vi.fn(async (name: string, id: string, data: Record<string, any>) => {
        if (!harness.records.has(`${name}/${id}`)) throw new Error('Cannot update a missing synthetic record.');
        return persist(`${name}/${id}`, data, 'update');
      }),
    },
  };
});
vi.mock('firebase-admin/storage', () => ({ getStorage: harness.forbiddenStorage }));
vi.mock('firebase-admin/messaging', () => ({ getMessaging: harness.forbiddenMessaging }));
vi.mock('./liveActivities', () => ({
  registerLiveActivityRoutes: vi.fn(),
  sendRideLiveActivityUpdate: harness.liveActivity,
  sendDriverLocationLiveActivityUpdates: harness.liveActivity,
}));
vi.mock('./liveRouteMetrics', () => ({
  refreshDriverActiveRideRoutes: harness.routeRefresh,
  fetchBookingRoadRouteWithStops: harness.routeRefresh,
  fetchRoadRoute: harness.routeRefresh,
  fetchRoadRouteWithStops: harness.routeRefresh,
}));
vi.mock('./email', () => ({
  sendTripReceiptEmail: harness.forbiddenEmail,
  sendVerificationEmail: harness.forbiddenEmail,
  sendPasswordResetEmail: harness.forbiddenEmail,
}));
vi.mock('./supportEmail', () => ({
  sendSupportEmail: harness.forbiddenEmail,
  supportEmailConfiguration: () => ({ configured: false }),
  SupportEmailError: class extends Error {},
}));

// These remain the actual production app, router mount, context, protected
// procedures, approval transaction, and Rider response serializer.
import { createApp } from './app';

const instant = new Date('2026-11-27T18:00:00.000Z');
const driverId = 'synthetic-driver-owner';
const riderId = 'synthetic-rider-owner';
const otherDriverId = 'synthetic-other-driver';
const otherRiderId = 'synthetic-other-rider';
const rideId = 'synthetic-selfie-trip';
const selfie = 'https://synthetic.invalid/registration-selfie.jpg';
const avatar = 'https://synthetic.invalid/legacy-avatar.jpg';
const legacyPhoto = 'https://synthetic.invalid/legacy-photo.jpg';
const sensitiveDocuments = Object.fromEntries([
  'ghana_card_front_url', 'ghana_card_back_url', 'ghana_card_url', 'id_card_url',
  'drivers_license_front_url', 'drivers_license_back_url', 'drivers_license_url',
  'license_photo_url', 'id_document_url', 'vehicle_photo_url', 'vehicle_registration_url',
  'insurance_url', 'roadworthy_url',
].map((field) => [field, `https://synthetic.invalid/private-documents/${field}.jpg`]));
const tokens = {
  'synthetic-driver-token': driverId,
  'synthetic-rider-token': riderId,
  'synthetic-other-driver-token': otherDriverId,
  'synthetic-other-rider-token': otherRiderId,
};
let server: Server;
let origin: string;

function approved(overrides: Record<string, any> = {}) {
  return {
    user_id: driverId, approval_status: 'approved', account_status: 'active', full_name: 'Synthetic Approved Driver',
    is_online: true, availability_status: 'online', ride_categories: ['standard'], service_type: 'car',
    profile_photo_url: selfie, avatar_url: avatar, photo_url: legacyPhoto, ...sensitiveDocuments,
    vehicle_make: 'Synthetic', vehicle_model: 'Test Car', vehicle_plate: 'SYNTHETIC-001', vehicle_colour: 'Blue',
    rating: 4.9, rating_count: 12, total_trips: 25,
    current_location: { latitude: 5.604, longitude: -0.1872, recorded_at: instant.toISOString() },
    ...overrides,
  };
}
function seed(overrides: Record<string, any> = {}) {
  harness.records.set(`driver_profiles/${driverId}`, approved(overrides));
  // Deliberately stale-approved presence cannot override pending/rejected/suspended authority.
  harness.records.set(`driver_presence/${driverId}`, {
    user_id: driverId, approval_status: 'approved', account_status: 'active', is_online: true,
    availability_status: 'online', ride_categories: ['standard'],
    current_location: { latitude: 5.604, longitude: -0.1872, recorded_at: instant.toISOString() },
  });
  harness.records.set(`rider_profiles/${riderId}`, { user_id: riderId, full_name: 'Synthetic Owning Rider', rating: 4.8, rating_count: 5 });
  // Booking/request creation is SEEDED, not exercised through the booking endpoint.
  harness.records.set(`rides/${rideId}`, {
    rider_id: riderId, rider_name: 'Synthetic Owning Rider', status: 'searching', category: 'standard',
    pickup: { lat: 5.6037, lng: -0.187, name: 'Synthetic pickup', address: 'Synthetic pickup address' },
    destination: { lat: 5.614, lng: -0.202, name: 'Synthetic destination', address: 'Synthetic destination address' },
    fare: 25, payment_method: 'cash', distance_km: 2, duration_minutes: 8,
    booking_route_points: [{ lat: 5.6037, lng: -0.187 }, { lat: 5.614, lng: -0.202 }],
    offered_driver_id: driverId, driver_offer_attempt: 1, driver_offer_status: 'offered',
    driver_offer_expires_at: new Date(instant.getTime() + 60_000).toISOString(), created_at: instant.toISOString(),
  });
}
function savedRide() { return harness.records.get(`rides/${rideId}`)!; }
function assertNoPrivateDocuments(value: unknown) {
  const json = JSON.stringify(value);
  for (const [field, url] of Object.entries(sensitiveDocuments)) {
    expect(json).not.toContain(field);
    expect(json).not.toContain(url);
  }
  expect(json).not.toContain(avatar);
  expect(json).not.toContain(legacyPhoto);
  expect(json).not.toContain('profile_photo_url');
  expect(json).not.toContain('avatar_url');
}
function assertNoPhotoOrAssignment(value: unknown) {
  assertNoPrivateDocuments(value);
  expect(JSON.stringify(value)).not.toContain(selfie);
  expect(savedRide()).toMatchObject({ status: 'searching', offered_driver_id: driverId });
  expect(savedRide()).not.toHaveProperty('driver_id');
  expect(savedRide()).not.toHaveProperty('driver');
  expect(harness.writes).toEqual([]);
}
async function localHttp(path: string, token?: string, init: RequestInit = {}) {
  const url = new URL(path, origin);
  const allowed = new URL(origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== allowed.port
    || url.origin !== origin || url.username || url.password) {
    throw new Error('Native fetch is restricted to the running loopback server and its exact ephemeral port.');
  }
  const response = await harness.nativeFetch(url, {
    ...init, redirect: 'error', signal: AbortSignal.timeout(5_000),
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers },
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}
async function accept(token: string | undefined = 'synthetic-driver-token', claimedDriverId = driverId) {
  return localHttp('/api/trpc/driverTrips.respondToOffer', token, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(superjson.serialize({ driverId: claimedDriverId, rideId, decision: 'accept' })),
  });
}
function status(token: string | undefined = 'synthetic-rider-token', id = rideId) {
  return localHttp(`/api/rides/${id}/status`, token);
}
function acceptanceData(body: Record<string, any>) {
  return superjson.deserialize(body.result.data) as { success: boolean; decision: string; ride: Record<string, any> };
}
function errorData(body: Record<string, any>) {
  return superjson.deserialize(body.error) as { message: string; data: { code: string } };
}

beforeAll(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  vi.unstubAllGlobals();
});
beforeEach(() => {
  // Fake Date ONLY: the HTTP server, fetch timeout, and socket timers stay real.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(instant);
  vi.clearAllMocks();
  harness.records.clear(); harness.writes = []; harness.reads = []; harness.transactions = harness.nextEvent = 0;
  harness.verifyIdToken.mockImplementation(async (token: string) => {
    const uid = tokens[token as keyof typeof tokens];
    if (!uid) throw new Error('Synthetic invalid token.');
    return { uid };
  });
  harness.records.set('platform_settings/driver_fee_bypass_all_drivers', {
    active: true, scope: 'all_approved_drivers', date: instant.toISOString().slice(0, 10),
  });
  seed();
});
afterEach(() => {
  expect(harness.externalFetch).not.toHaveBeenCalled();
  expect(harness.forbiddenAuth).not.toHaveBeenCalled();
  expect(harness.forbiddenStorage).not.toHaveBeenCalled();
  expect(harness.forbiddenMessaging).not.toHaveBeenCalled();
  expect(harness.forbiddenEmail).not.toHaveBeenCalled();
  expect(harness.routeRefresh).not.toHaveBeenCalled();
  vi.useRealTimers();
});

describe('Synthetic Rider–Driver acceptance HTTP simulation (no external services)', () => {
  it('carries the registration selfie from real HTTP acceptance through the saved ride and repeated owning-Rider status reads', async () => {
    const searching = await status();
    expect(searching.status).toBe(200);
    expect(searching.body.ride.status).toBe('searching');
    expect(searching.body.ride).not.toHaveProperty('driver');

    const response = await accept();
    expect(response.status).toBe(200);
    const accepted = acceptanceData(response.body);
    expect(accepted).toMatchObject({ success: true, decision: 'accept', ride: { driver_id: driverId, status: 'driver_arriving', driver: { id: driverId, photo_url: selfie } } });
    expect(savedRide().driver).toEqual(accepted.ride.driver);
    const assignment = harness.writes.find((write) => write.key === `rides/${rideId}` && write.source === 'transaction');
    expect(assignment?.data.driver.photo_url).toBe(selfie);
    expect(harness.transactions).toBe(1);
    expect(harness.reads).toContain(`driver_profiles/${driverId}`);
    expect(harness.reads).toContain('driver_profiles/query');
    expect(harness.verifyIdToken).toHaveBeenCalledWith('synthetic-driver-token', true);
    expect(harness.liveActivity).toHaveBeenCalledOnce();
    for (const value of [response.body, accepted, savedRide(), assignment?.data]) assertNoPrivateDocuments(value);

    const reads = [];
    for (let read = 0; read < 3; read++) {
      const current = await status();
      expect(current.status).toBe(200);
      expect(current.body).toMatchObject({ success: true, ride: { id: rideId, rider_id: riderId, driver_id: driverId, status: 'driver_arriving', driver: { photo_url: selfie } } });
      expect(current.body.ride.booking_route_points).toEqual([[5.6037, -0.187], [5.614, -0.202]]);
      expect(current.body.ride.driver).toEqual(accepted.ride.driver);
      assertNoPrivateDocuments(current.body);
      reads.push(current);
    }
    expect(reads[1].body).toEqual(reads[0].body);
    expect(reads[2].body).toEqual(reads[0].body);
    expect(savedRide().driver.photo_url).toBe(selfie);

    // Opt-in evidence output keeps ordinary test runs free of filesystem artifacts.
    const evidenceDir = process.env.SELFIE_SIMULATION_EVIDENCE_DIR;
    if (evidenceDir) {
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(`${evidenceDir}/flow-trace.json`, `${JSON.stringify({
        schemaVersion: 1, syntheticOnly: true, backendCommit: '72a66d7048db64029ad1012a6d7ef6a175b9c3d9',
        simulatedAt: instant.toISOString(), actors: { driverId, riderId, otherDriverId, otherRiderId },
        fixtureCreation: 'Seeded in-memory searching Rider request with active Driver offer; booking endpoint NOT exercised.',
        transport: 'Real HTTP on 127.0.0.1 ephemeral port via createApp; real production tRPC acceptance and Rider status handlers.',
        phases: [
          { phase: 'seeded_searching_request', statusResponse: searching },
          { phase: 'driver_accepted', method: 'POST', path: '/api/trpc/driverTrips.respondToOffer', httpStatus: response.status, acceptanceResponse: accepted },
          { phase: 'assignment_persisted_in_memory', ride: structuredClone(savedRide()) },
          { phase: 'owning_rider_status', method: 'GET', path: `/api/rides/${rideId}/status`, httpStatus: reads[0].status, responseBody: reads[0].body },
          { phase: 'repeat_owning_rider_reads', httpStatuses: reads.map((read) => read.status), photos: reads.map((read) => read.body.ride.driver.photo_url) },
        ],
        owningRiderStatusResponse: reads[0].body,
        photoAssertions: { accepted: accepted.ride.driver.photo_url, persisted: savedRide().driver.photo_url, owningRider: reads[0].body.ride.driver.photo_url },
        externalFetchAttempts: harness.externalFetch.mock.calls.length,
        limits: ['No real device or mobile execution', 'No selfie/image download or rendering', 'No real Firebase, storage, payment, notification, or email writes', 'In-memory transaction simulation; existing race regressions remain separate'],
      }, null, 2)}\n`);
    }
  });

  it.each([
    { label: 'pending', state: { approval_status: 'pending' } },
    { label: 'rejected', state: { approval_status: 'rejected' } },
    { label: 'suspended', state: { account_status: 'suspended' } },
  ])('cannot claim or expose a selfie for a $label Driver despite stale-approved presence and a synthetic fee waiver', async ({ state }) => {
    seed(state);
    const response = await accept();
    expect(response.status).toBe(500); // Existing approvalRequiredError is an ordinary Error.
    expect(errorData(response.body).message).toContain('must be approved');
    assertNoPhotoOrAssignment(response.body);
    const own = await status();
    expect(own.status).toBe(200);
    assertNoPhotoOrAssignment(own.body);
  });

  it('rejects a wrong authenticated Driver UID spoofing the offered Driver input before reading or assigning', async () => {
    const response = await accept('synthetic-other-driver-token');
    expect(response.status).toBe(403);
    expect(errorData(response.body).data.code).toBe('FORBIDDEN');
    expect(harness.reads).toEqual([]);
    expect(harness.transactions).toBe(0);
    assertNoPhotoOrAssignment(response.body);
  });

  it('rejects another approved Driver claiming the offer using their own correct authenticated UID', async () => {
    harness.records.set(`driver_profiles/${otherDriverId}`, approved({ user_id: otherDriverId }));
    const response = await accept('synthetic-other-driver-token', otherDriverId);
    expect(response.status).toBe(500);
    expect(errorData(response.body).message).toContain('no longer available');
    assertNoPhotoOrAssignment(response.body);
  });

  it.each([
    { label: 'anonymous', token: '' },
    { label: 'invalid-token', token: 'synthetic-invalid-token' },
  ])('denies an $label Driver acceptance with 401 and no assignment or photo', async ({ token }) => {
    const response = await accept(token);
    expect(response.status).toBe(401);
    expect(errorData(response.body).data.code).toBe('UNAUTHORIZED');
    expect(harness.reads).toEqual([]);
    expect(harness.transactions).toBe(0);
    assertNoPhotoOrAssignment(response.body);
  });

  it('returns the same generic 404 for another Rider and a missing ride after successful acceptance, without leaking the assigned selfie', async () => {
    expect((await accept()).status).toBe(200);
    const before = structuredClone(savedRide());
    const writes = structuredClone(harness.writes);
    const denied = await status('synthetic-other-rider-token');
    const missing = await status('synthetic-other-rider-token', 'synthetic-missing-ride');
    expect(denied.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(denied.body).toEqual({ success: false, message: 'Ride not found.' });
    expect(denied.body).toEqual(missing.body);
    expect(JSON.stringify(denied.body)).not.toContain(selfie);
    assertNoPrivateDocuments(denied.body);
    expect(savedRide()).toEqual(before);
    expect(harness.writes).toEqual(writes);
  });

  it.each([
    { label: 'anonymous', token: '' },
    { label: 'invalid-token', token: 'synthetic-invalid-token' },
  ])('returns 401 for an $label Rider status read without reading, writing, or leaking an accepted ride', async ({ token }) => {
    expect((await accept()).status).toBe(200);
    const before = structuredClone(savedRide());
    const writes = structuredClone(harness.writes);
    harness.reads = [];
    const denied = await status(token);
    expect(denied.status).toBe(401);
    expect(denied.body.success).toBe(false);
    expect(JSON.stringify(denied.body)).not.toContain(selfie);
    assertNoPrivateDocuments(denied.body);
    expect(harness.reads).toEqual([]);
    expect(savedRide()).toEqual(before);
    expect(harness.writes).toEqual(writes);
  });

  it('preserves the accepted selfie snapshot on Rider recovery reads even if the profile photo later changes', async () => {
    expect((await accept()).status).toBe(200);
    harness.records.set(`driver_profiles/${driverId}`, approved({ profile_photo_url: 'https://synthetic.invalid/later-selfie.jpg' }));
    const writes = structuredClone(harness.writes);
    for (let read = 0; read < 2; read++) {
      const current = await status();
      expect(current.status).toBe(200);
      expect(current.body.ride.driver.photo_url).toBe(selfie);
      assertNoPrivateDocuments(current.body);
    }
    expect(savedRide().driver.photo_url).toBe(selfie);
    expect(harness.writes).toEqual(writes);
  });
});
