import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  records: new Map<string, Record<string, any>>(),
  writes: [] as Array<{ key: string; data: Record<string, any> }>,
  reads: [] as string[],
  attempts: 0,
  beforeTransaction: null as (() => void) | null,
  retryWith: null as (() => void) | null,
  fetch: vi.fn(),
}));

vi.mock('./firebaseAdmin', () => {
  const snapshot = (key: string) => {
    const value = harness.records.get(key);
    return { id: key.split('/').at(-1)!, exists: Boolean(value), data: () => value ? structuredClone(value) : undefined };
  };
  const collection = (name: string) => {
    const query: any = {
      name, filters: [] as Array<[string, any]>, maximum: Infinity,
      where(field: string, _operator: string, value: any) { return { ...this, filters: [...this.filters, [field, value]] }; },
      orderBy() { return this; },
      limit(maximum: number) { return { ...this, maximum }; },
      doc(id: string) { return { key: `${name}/${id}` }; },
    };
    return query;
  };
  const list = (name: string, filters: Record<string, any> = {}) => [...harness.records.entries()]
    .filter(([key, data]) => key.startsWith(`${name}/`) && Object.entries(filters).every(([field, value]) => data[field] === value))
    .map(([key, data]) => ({ ...structuredClone(data), id: key.split('/').at(-1)! }));
  const db = {
    collection,
    async runTransaction(callback: (transaction: any) => Promise<any>) {
      harness.beforeTransaction?.();
      harness.beforeTransaction = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        harness.attempts++;
        const pending: Array<{ key: string; data: Record<string, any> }> = [];
        const transaction = {
          async get(ref: any) {
            if (pending.length) throw new Error('Transaction reads must precede writes.');
            if (ref.key) { harness.reads.push(ref.key); return snapshot(ref.key); }
            harness.reads.push(`${ref.name}/query`);
            const docs = list(ref.name, Object.fromEntries(ref.filters)).slice(0, ref.maximum)
              .map((data) => snapshot(`${ref.name}/${data.id}`));
            return { docs };
          },
          update(ref: any, data: any) { pending.push({ key: ref.key, data }); },
          set(ref: any, data: any) { pending.push({ key: ref.key, data }); },
        };
        const result = await callback(transaction);
        // Model Firestore conflict retry: the first attempt's writes are discarded.
        if (harness.retryWith) { const retry = harness.retryWith; harness.retryWith = null; retry(); continue; }
        for (const write of pending) {
          harness.writes.push(write);
          harness.records.set(write.key, { ...harness.records.get(write.key), ...write.data });
        }
        return result;
      }
      throw new Error('Unexpected repeated transaction conflict.');
    },
  };
  return {
    ADMIN_COLLECTIONS: {
      DRIVER_PROFILES: 'driver_profiles', RIDES: 'rides', RIDER_PROFILES: 'rider_profiles',
      PUSH_DEVICES: 'push_devices', RIDE_EVENTS: 'ride_events', DAILY_COMMISSION: 'daily_commissions',
      RIDE_REPORTS: 'ride_reports', SOS_INCIDENTS: 'sos_incidents',
    },
    getAdminDb: () => db,
    getAdminAuth: () => ({ getUser: vi.fn().mockRejectedValue(new Error('No Auth requests in unit tests.')) }),
    adminFirestore: {
      get: vi.fn(async (name: string, id: string) => {
        const value = harness.records.get(`${name}/${id}`);
        return value ? { ...structuredClone(value), id } : null;
      }),
      list: vi.fn(async (name: string, filters: Record<string, any> = {}) => list(name, filters)),
      create: vi.fn(async () => ({ id: 'event' })),
      update: vi.fn(async (name: string, id: string, data: any) => {
        harness.records.set(`${name}/${id}`, { ...harness.records.get(`${name}/${id}`), ...data });
      }),
      updateDriverRideIfStatus: vi.fn(async (rideId: string, driverId: string, statuses: string[], data: any) => {
        const ride = harness.records.get(`rides/${rideId}`)!;
        if (ride.driver_id !== driverId || !statuses.includes(ride.status)) throw new Error('Wrong Driver assignment or state.');
        const updated = { ...ride, ...data };
        harness.records.set(`rides/${rideId}`, updated);
        return updated;
      }),
      completeRideAndSynchronizeDriverTripCount: vi.fn(async (rideId: string, driverId: string, data: any) => {
        const ride = harness.records.get(`rides/${rideId}`)!;
        if (ride.driver_id !== driverId || ride.status !== 'in_progress') throw new Error('Wrong Driver assignment or state.');
        const updated = { ...ride, ...data };
        harness.records.set(`rides/${rideId}`, updated);
        return { ride: updated, totalTrips: 1, alreadyCompleted: false };
      }),
    },
  };
});
vi.mock('./liveActivities', () => ({ sendRideLiveActivityUpdate: vi.fn(async () => ({})), sendDriverLocationLiveActivityUpdates: vi.fn(async () => ({})) }));
vi.mock('./liveRouteMetrics', () => ({ refreshDriverActiveRideRoutes: vi.fn(async () => ({})) }));
vi.mock('./email', () => ({ sendTripReceiptEmail: vi.fn(async () => false) }));

import { adminFirestore } from './firebaseAdmin';
import { driverOperations, driverTrips } from './driverRouters';
import { dispatchNextDriverRideOffer } from './driverOfferDispatch';
import { sendDriverRideOfferPush } from './driverOfferPush';

const instant = new Date('2026-11-24T21:00:00.000Z');
const callerContext = { uid: 'driver-1', email: null, adminAccessProof: '' };
const trips = () => driverTrips.createCaller(callerContext);
const operations = () => driverOperations.createCaller(callerContext);
function approved(overrides: Record<string, any> = {}) {
  return {
    user_id: 'driver-1', approval_status: 'approved', account_status: 'active', full_name: 'Approved Driver',
    is_online: true, availability_status: 'online', ride_categories: ['standard'],
    current_location: { latitude: 5.604, longitude: -0.1872, recorded_at: instant.toISOString() }, ...overrides,
  };
}
function ride(overrides: Record<string, any> = {}) {
  return {
    status: 'searching', category: 'standard', pickup: { lat: 5.6037, lng: -0.187 },
    offered_driver_id: 'driver-1', driver_offer_attempt: 1,
    driver_offer_expires_at: new Date(instant.getTime() + 60_000).toISOString(),
    ...overrides,
  };
}
function seed(profile: Record<string, any> | null = approved(), currentRide = ride()) {
  if (profile) harness.records.set('driver_profiles/driver-1', profile);
  harness.records.set('driver_presence/driver-1', approved());
  harness.records.set('rides/ride-1', currentRide);
}
function reject() {
  harness.records.set('driver_profiles/driver-1', approved({ approval_status: 'rejected', availability_status: 'offline', is_online: false }));
  harness.records.set('driver_presence/driver-1', approved({ approval_status: 'rejected', availability_status: 'offline', is_online: false }));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(instant);
  harness.records.clear(); harness.writes = []; harness.reads = []; harness.attempts = 0;
  harness.beforeTransaction = null; harness.retryWith = null;
  vi.clearAllMocks();
  harness.fetch.mockResolvedValue({ ok: true, json: async () => ({ data: [{ status: 'ok' }] }) });
  vi.stubGlobal('fetch', harness.fetch);
  // A persisted admin fee waiver tests that fee access is NOT approval authority.
  harness.records.set('platform_settings/driver_fee_bypass_all_drivers', {
    active: true, scope: 'all_approved_drivers', date: '2026-11-24',
  });
});

describe('Driver lifecycle assignment boundary', () => {
  it.each(['arrive', 'activateQueued'] as const)('%s cannot claim an arbitrary unassigned ride', async (action) => {
    for (const profile of [null, approved({ approval_status: 'pending' }), approved({ approval_status: 'rejected' }), approved()]) {
      seed(profile);
      if (!profile) harness.records.delete('driver_profiles/driver-1');
      await expect(trips()[action]({ driverId: 'driver-1', rideId: 'ride-1' })).rejects.toThrow('no longer eligible');
      expect(harness.writes).toEqual([]);
      expect(harness.records.get('rides/ride-1')).not.toHaveProperty('driver_id');
    }
  });

  it.each(['arrive', 'activateQueued'] as const)('%s requires approval even with an existing assignment', async (action) => {
    for (const profile of [null, approved({ approval_status: 'pending' }), approved({ approval_status: 'rejected' }), approved({ account_status: 'suspended' })]) {
      seed(profile, ride({ driver_id: 'driver-1', status: action === 'arrive' ? 'driver_arriving' : 'driver_queued' }));
      if (!profile) harness.records.delete('driver_profiles/driver-1');
      await expect(trips()[action]({ driverId: 'driver-1', rideId: 'ride-1' })).rejects.toThrow('must be approved');
      expect(harness.writes).toEqual([]);
    }
  });

  it.each(['arrive', 'activateQueued'] as const)('%s rejects the wrong owner and wrong source states', async (action) => {
    seed(approved(), ride({ driver_id: 'other-driver', status: action === 'arrive' ? 'driver_arriving' : 'driver_queued' }));
    await expect(trips()[action]({ driverId: 'driver-1', rideId: 'ride-1' })).rejects.toThrow('no longer eligible');
    for (const status of ['searching', 'completed', 'cancelled', 'in_progress', action === 'arrive' ? 'driver_queued' : 'driver_arriving']) {
      seed(approved(), ride({ driver_id: 'driver-1', status }));
      await expect(trips()[action]({ driverId: 'driver-1', rideId: 'ride-1' })).rejects.toThrow('no longer eligible');
    }
    expect(harness.writes).toEqual([]);
  });

  it('allows approved owned queued activation and arrival without rewriting valid trip material', async () => {
    seed(approved(), ride({ driver_id: 'driver-1', status: 'driver_queued', queued_after_ride_id: 'previous', fare_rate_snapshot: { category: 'standard' }, pickup_code: '1234' }));
    await trips().activateQueued({ driverId: 'driver-1', rideId: 'ride-1', completedRideId: 'previous' });
    const result = await trips().arrive({ driverId: 'driver-1', rideId: 'ride-1' });
    expect(result.ride).toMatchObject({ driver_id: 'driver-1', status: 'driver_arrived', pickup_code: '1234', fare_rate_snapshot: { category: 'standard' } });
    expect(harness.writes.every((write) => !Object.hasOwn(write.data, 'driver_id'))).toBe(true);
  });

  it('denies an activation for the wrong preceding trip', async () => {
    seed(approved(), ride({ driver_id: 'driver-1', status: 'driver_queued', queued_after_ride_id: 'previous' }));
    await expect(trips().activateQueued({ driverId: 'driver-1', rideId: 'ride-1', completedRideId: 'wrong' })).rejects.toThrow('another preceding trip');
    expect(harness.writes).toEqual([]);
  });

  it.each(['arrive', 'activateQueued'] as const)('%s does not overwrite a concurrent redispatch', async (action) => {
    seed(approved(), ride({ driver_id: 'driver-1', status: action === 'arrive' ? 'driver_arriving' : 'driver_queued' }));
    harness.retryWith = () => harness.records.set('rides/ride-1', ride({ driver_id: 'other-driver', status: 'driver_arriving' }));
    await expect(trips()[action]({ driverId: 'driver-1', rideId: 'ride-1' })).rejects.toThrow('no longer eligible');
    expect(harness.attempts).toBe(2);
    expect(harness.writes).toEqual([]);
  });

  it.each(['arrive', 'activateQueued'] as const)('%s does not commit after a manual rejection conflict', async (action) => {
    seed(approved(), ride({ driver_id: 'driver-1', status: action === 'arrive' ? 'driver_arriving' : 'driver_queued' }));
    harness.retryWith = reject;
    await expect(trips()[action]({ driverId: 'driver-1', rideId: 'ride-1' })).rejects.toThrow('must be approved');
    expect(harness.attempts).toBe(2);
    expect(harness.writes).toEqual([]);
  });

  it('pickup verification and start cannot claim unassigned or reassigned rides', async () => {
    seed(approved(), ride({ status: 'driver_arrived', pickup_code: '1234' }));
    await expect(trips().verifyPickup({ driverId: 'driver-1', rideId: 'ride-1', pickupCode: '1234' })).rejects.toThrow('no longer eligible');
    await expect(trips().start({ driverId: 'driver-1', rideId: 'ride-1' })).rejects.toThrow('not assigned');
    await expect(trips().verifyAndStart({ driverId: 'driver-1', rideId: 'ride-1', pickupCode: '1234' })).rejects.toThrow('not assigned');
    seed(approved(), ride({ driver_id: 'driver-1', status: 'driver_arrived', pickup_verified_at: instant.toISOString() }));
    harness.beforeTransaction = () => harness.records.set('rides/ride-1', ride({ driver_id: 'other-driver', status: 'driver_arrived' }));
    await expect(trips().start({ driverId: 'driver-1', rideId: 'ride-1' })).rejects.toThrow('no longer eligible');
    expect(harness.writes).toEqual([]);
  });

  it('keeps an already legitimate arrived trip startable after approval is revoked', async () => {
    seed(approved({ approval_status: 'rejected' }), ride({ driver_id: 'driver-1', status: 'driver_arrived', pickup_code: '1234' }));
    const result = await trips().verifyAndStart({ driverId: 'driver-1', rideId: 'ride-1', pickupCode: '1234', startLocation: { latitude: 5.604, longitude: -0.1872 } });
    expect(result.ride.status).toBe('in_progress');
    expect(result.ride.trip_meter).toBeDefined();
    expect(harness.reads).not.toContain('driver_profiles/driver-1');
  });

  it('keeps completion and pre-start cancellation available for revoked assigned Drivers', async () => {
    seed(approved({ approval_status: 'rejected' }), ride({ driver_id: 'driver-1', status: 'in_progress', trip_started_at: instant.toISOString(), fare: 25, distance_km: 2 }));
    const completed = await trips().complete({ driverId: 'driver-1', rideId: 'ride-1' });
    expect(completed.ride.status).toBe('completed');
    expect(adminFirestore.completeRideAndSynchronizeDriverTripCount).toHaveBeenCalledOnce();
    seed(approved({ approval_status: 'rejected' }), ride({ driver_id: 'driver-1', status: 'driver_arriving' }));
    const cancelled = await trips().cancel({ driverId: 'driver-1', rideId: 'ride-1', reason: 'Safety' });
    expect(cancelled.redispatched).toBe(true);
    expect(cancelled.ride.driver_id).toBeNull();
    expect(adminFirestore.updateDriverRideIfStatus).toHaveBeenCalledOnce();
  });
});

describe('Driver online and acceptance commit authority', () => {
  it('keeps new pending profiles offline, including a client busy request', async () => {
    seed(approved({ approval_status: 'pending' }));
    await expect(operations().setAvailability({ driverId: 'driver-1', status: 'online' })).rejects.toThrow('must be approved');
    const response = await operations().setAvailability({ driverId: 'driver-1', status: 'busy' });
    expect(response.status).toBe('offline');
    expect(harness.records.get('driver_presence/driver-1')).toMatchObject({ approval_status: 'pending', is_online: false, availability_status: 'offline' });
  });

  it.each(['before', 'retry'] as const)('online cannot undo rejection at %s commit boundary', async (race) => {
    seed();
    if (race === 'before') harness.beforeTransaction = reject; else harness.retryWith = reject;
    await expect(operations().setAvailability({ driverId: 'driver-1', status: 'online' })).rejects.toThrow('must be approved');
    expect(harness.records.get('driver_presence/driver-1')?.is_online).toBe(false);
    expect(harness.writes).toEqual([]);
  });

  it('foreground GPS cannot republish approved online presence after a rejection retry', async () => {
    seed(); harness.retryWith = reject;
    await expect(operations().updateLocation({ driverId: 'driver-1', latitude: 5.6, longitude: -0.1 })).rejects.toThrow('must be approved');
    expect(harness.writes).toEqual([]);
    expect(harness.records.get('driver_presence/driver-1')?.is_online).toBe(false);
  });

  it('allows approved online/GPS writes and preserves map projection', async () => {
    seed();
    await operations().setAvailability({ driverId: 'driver-1', status: 'online' });
    await operations().updateLocation({ driverId: 'driver-1', latitude: 5.61, longitude: -0.19, heading: 30 });
    expect(harness.records.get('driver_presence/driver-1')).toMatchObject({ approval_status: 'approved', account_status: 'active', is_online: true, current_location: { latitude: 5.61, longitude: -0.19, heading: 30 } });
    expect(harness.reads).toContain('driver_profiles/driver-1');
    expect(harness.reads).toContain('driver_profiles/query');
  });

  it.each(['before', 'retry'] as const)('accept cannot assign after rejection at %s commit boundary even with fee waiver', async (race) => {
    seed();
    if (race === 'before') harness.beforeTransaction = reject; else harness.retryWith = reject;
    await expect(trips().respondToOffer({ driverId: 'driver-1', rideId: 'ride-1', decision: 'accept' })).rejects.toThrow('must be approved');
    expect(harness.records.get('rides/ride-1')).not.toHaveProperty('driver_id');
    expect(harness.writes).toEqual([]);
  });

  it('accept cannot assign after changed application becomes pending', async () => {
    seed(); harness.retryWith = () => harness.records.set('driver_profiles/driver-1', approved({ approval_status: 'pending' }));
    await expect(trips().respondToOffer({ driverId: 'driver-1', rideId: 'ride-1', decision: 'accept' })).rejects.toThrow('must be approved');
    expect(harness.writes).toEqual([]);
  });

  it('still accepts the legitimate current offer when approval remains approved', async () => {
    seed();
    const result = await trips().respondToOffer({ driverId: 'driver-1', rideId: 'ride-1', decision: 'accept' });
    expect(result.ride).toMatchObject({ driver_id: 'driver-1', status: 'driver_arriving', offered_driver_id: null, driver_offer_status: 'accepted' });
    expect(harness.reads).toContain('driver_profiles/driver-1');
    expect(harness.reads).toContain('driver_profiles/query');
  });

  it('rechecks target ownership and queued current trip in the assignment transaction', async () => {
    seed(); harness.beforeTransaction = () => harness.records.set('rides/ride-1', ride({ offered_driver_id: 'other-driver' }));
    await expect(trips().respondToOffer({ driverId: 'driver-1', rideId: 'ride-1', decision: 'accept' })).rejects.toThrow('no longer available');
    seed(); harness.records.set('rides/current', ride({ driver_id: 'driver-1', status: 'in_progress' }));
    harness.beforeTransaction = () => harness.records.set('rides/current', ride({ driver_id: 'other-driver', status: 'in_progress' }));
    await expect(trips().respondToOffer({ driverId: 'driver-1', rideId: 'ride-1', decision: 'accept', queueAfterRideId: 'current' })).rejects.toThrow('assigned current trip');
    expect(harness.writes).toEqual([]);
  });

  it('canonical pending defeats an approved legacy alias during online commit', async () => {
    seed(approved({ approval_status: 'pending' }));
    harness.records.set('driver_profiles/legacy', approved());
    await expect(operations().setAvailability({ driverId: 'driver-1', status: 'online' })).rejects.toThrow('must be approved');
    expect(harness.writes).toEqual([]);
  });

  it('cannot write a UID profile belonging to another account, even for offline presence', async () => {
    seed(approved({ user_id: 'other-driver' }));
    await expect(operations().setAvailability({ driverId: 'driver-1', status: 'offline' })).rejects.toThrow('ownership');
    expect(harness.writes).toEqual([]);
    expect(harness.records.get('driver_profiles/driver-1')?.user_id).toBe('other-driver');
  });

  it('unchanged approved legacy application remains operational with a UID presence-only stub', async () => {
    seed({ user_id: 'driver-1', is_online: true, availability_status: 'online' });
    harness.records.set('driver_profiles/legacy', approved());
    await operations().setAvailability({ driverId: 'driver-1', status: 'online' });
    expect(harness.records.get('driver_presence/driver-1')?.approval_status).toBe('approved');
    expect(harness.writes.map((write) => write.key)).toContain('driver_profiles/legacy');
    expect(harness.reads).toContain('driver_profiles/query');
  });
});

describe('Driver offer lease and push approval', () => {
  it.each([
    { approval_status: 'pending' }, { approval_status: 'rejected' },
    { account_status: 'suspended' }, { account_status: 'inactive' },
  ])('never leases or wakes fresh stale-approved presence when authoritative profile is %j', async (state) => {
    seed(approved(state), ride({ offered_driver_id: null, driver_offer_attempt: 0, driver_offer_expires_at: null }));
    const transition = await dispatchNextDriverRideOffer('ride-1');
    expect(transition.dispatched).toBe(false);
    expect(harness.records.get('rides/ride-1')?.offered_driver_id).toBeNull();
    expect(harness.fetch).not.toHaveBeenCalled();
  });

  it('does not lease a missing-profile Driver despite approved presence and fee waiver', async () => {
    seed(null, ride({ offered_driver_id: null, driver_offer_attempt: 0, driver_offer_expires_at: null }));
    expect((await dispatchNextDriverRideOffer('ride-1')).dispatched).toBe(false);
    expect(harness.fetch).not.toHaveBeenCalled();
  });

  it('manual rejection during a lease transaction retry cannot persist a new offer', async () => {
    seed(approved(), ride({ offered_driver_id: null, driver_offer_attempt: 0, driver_offer_expires_at: null }));
    harness.retryWith = reject;
    const transition = await dispatchNextDriverRideOffer('ride-1');
    expect(transition.dispatched).toBe(false);
    expect(harness.attempts).toBe(2);
    expect(harness.writes.every((write) => !write.data.offered_driver_id)).toBe(true);
    expect(harness.fetch).not.toHaveBeenCalled();
  });

  it('leases and sends a privacy-safe wake-up only to the legitimate approved recipient', async () => {
    seed(approved(), ride({ offered_driver_id: null, driver_offer_attempt: 0, driver_offer_expires_at: null }));
    harness.records.set('push_devices/device', { uid: 'driver-1', role: 'driver', active: true, token: 'ExponentPushToken[driver-token]' });
    const result = await dispatchNextDriverRideOffer('ride-1');
    expect(result.dispatched).toBe(true);
    expect(result.ride?.offered_driver_id).toBe('driver-1');
    expect(harness.fetch).toHaveBeenCalledOnce();
    const payload = JSON.parse(harness.fetch.mock.calls[0][1].body);
    expect(payload[0].data).toEqual({ type: 'ride_offer', rideId: 'ride-1' });
    expect(harness.reads).toContain('driver_profiles/driver-1');
    expect(harness.reads).toContain('driver_profiles/query');
    expect(harness.reads).toContain('driver_presence/driver-1');
  });

  it.each([null, { approval_status: 'pending' }, { approval_status: 'rejected' }, { account_status: 'disabled' }])('push rejects missing/unapproved/inactive authority before querying tokens: %j', async (state) => {
    seed(state ? approved(state) : null);
    harness.records.set('push_devices/device', { uid: 'driver-1', role: 'driver', active: true, token: 'ExponentPushToken[driver-token]' });
    const result = await sendDriverRideOfferPush('ride-1', ride());
    expect(result).toEqual({ attempted: 0, sent: 0 });
    expect(harness.fetch).not.toHaveBeenCalled();
    expect(adminFirestore.list).not.toHaveBeenCalledWith('push_devices', expect.anything(), expect.anything(), expect.anything(), expect.anything());
  });
});
