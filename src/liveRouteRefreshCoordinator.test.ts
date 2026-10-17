import { describe, expect, it } from 'vitest';
import {
  createLiveRouteRefreshCoordinator,
  type LiveRouteRefreshRequest,
  type LiveRouteRefreshStorage,
} from './liveRouteRefreshCoordinator';
import type { RoadRouteMetrics } from './liveRouteMetrics';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function eventually(check: () => boolean, attempts = 30): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (check()) return;
    await Promise.resolve();
  }
  throw new Error('Expected asynchronous work to become ready.');
}

const route = (distanceKm: number): RoadRouteMetrics => ({
  distanceKm,
  durationMinutes: distanceKm * 4,
  points: [[5.6, -0.19], [5.61, -0.18]],
  source: 'osrm',
});

function request(overrides: Partial<LiveRouteRefreshRequest> = {}): LiveRouteRefreshRequest {
  return {
    rideId: 'ride-1',
    driverId: 'driver-1',
    from: { latitude: 5.6, longitude: -0.19 },
    target: { latitude: 5.61, longitude: -0.18 },
    targetKey: '5.61000:-0.18000',
    phase: 'pickup',
    targetKind: 'pickup',
    ...overrides,
  };
}

type FakeRide = Pick<LiveRouteRefreshRequest, 'driverId' | 'target' | 'targetKey' | 'phase'> & {
  lease: { token: string; request: LiveRouteRefreshRequest } | null;
  published: Array<{ request: LiveRouteRefreshRequest; metrics: RoadRouteMetrics; calculatedAt: string }>;
};

/** Models the exact owner/phase/coordinate/token checks made by the Firestore transaction. */
function guardedStorage(ride: FakeRide): LiveRouteRefreshStorage {
  let token = 0;
  const matchesCurrent = (candidate: LiveRouteRefreshRequest) => (
    candidate.driverId === ride.driverId
    && candidate.phase === ride.phase
    && candidate.targetKey === ride.targetKey
    && candidate.target.latitude === ride.target.latitude
    && candidate.target.longitude === ride.target.longitude
  );

  return {
    async claim(candidate) {
      if (!matchesCurrent(candidate)) return null;
      if (ride.lease && matchesCurrent(ride.lease.request)) return null;
      const lease = { token: `lease-${++token}`, request: candidate };
      ride.lease = lease;
      return { token: lease.token };
    },
    async publish(candidate, lease, metrics, calculatedAt) {
      if (!matchesCurrent(candidate) || ride.lease?.token !== lease.token) return false;
      ride.published.push({ request: candidate, metrics, calculatedAt });
      // The production Firestore publisher consumes/deletes a successful
      // in-flight lease in the same transaction.
      ride.lease = null;
      return true;
    },
    async release(candidate, lease) {
      if (ride.lease?.token === lease.token && matchesCurrent(candidate)) ride.lease = null;
    },
  };
}

describe('live-route refresh coordinator', () => {
  it('rejects a late old result after target/phase changes, then publishes the latest route', async () => {
    const oldRoute = deferred<RoadRouteMetrics | null>();
    const newRoute = deferred<RoadRouteMetrics | null>();
    const queued = [oldRoute, newRoute];
    const ride: FakeRide = {
      driverId: 'driver-1',
      phase: 'pickup',
      target: { latitude: 5.61, longitude: -0.18 },
      targetKey: '5.61000:-0.18000',
      lease: null,
      published: [],
    };
    const coordinator = createLiveRouteRefreshCoordinator({
      storage: guardedStorage(ride),
      fetchRoute: async () => queued.shift()!.promise,
      refreshMs: 8_000,
    });

    const oldRequest = request();
    const refresh = coordinator.request(oldRequest);
    await eventually(() => queued.length === 1);

    // Simulates a server lifecycle/target transaction occurring while an old
    // directions request is delayed. The stale publish must fail atomically.
    const latest = request({
      target: { latitude: 5.57, longitude: -0.17 },
      targetKey: '5.57000:-0.17000',
      phase: 'destination',
      targetKind: 'destination',
    });
    ride.phase = latest.phase;
    ride.target = latest.target;
    ride.targetKey = latest.targetKey;
    ride.lease = null; // lifecycle update invalidates the prior lease/token.
    void coordinator.request(latest);

    oldRoute.resolve(route(9));
    await eventually(() => queued.length === 0);
    newRoute.resolve(route(2));

    await expect(refresh).resolves.toEqual({ fetched: 2, published: 1 });
    expect(ride.published).toHaveLength(1);
    expect(ride.published[0]).toMatchObject({
      request: { phase: 'destination', targetKey: '5.57000:-0.17000' },
      metrics: { distanceKm: 2 },
    });
  });

  it('coalesces many moving GPS samples into one running call plus one latest trailing call', async () => {
    const first = deferred<RoadRouteMetrics | null>();
    const second = deferred<RoadRouteMetrics | null>();
    const queued = [first, second];
    const initial = request();
    const ride: FakeRide = {
      driverId: initial.driverId,
      phase: initial.phase,
      target: initial.target,
      targetKey: initial.targetKey,
      lease: null,
      published: [],
    };
    let providerCalls = 0;
    const coordinator = createLiveRouteRefreshCoordinator({
      storage: guardedStorage(ride),
      fetchRoute: async () => {
        providerCalls += 1;
        return queued.shift()!.promise;
      },
      refreshMs: 8_000,
      trailingMovementMeters: 20,
    });

    const refresh = coordinator.request(initial);
    await eventually(() => providerCalls === 1);
    for (let index = 1; index <= 25; index += 1) {
      // ~33m per sample: every sample is materially newer, yet only the newest
      // is retained while the first router request is running.
      void coordinator.request(request({ from: { latitude: 5.6 + index * 0.0003, longitude: -0.19 } }));
    }

    first.resolve(route(4));
    await eventually(() => providerCalls === 2);
    // GPS continues while the trailing request is pending. This must still be
    // a finite run, not an endless chain of provider fetches.
    for (let index = 26; index <= 40; index++) {
      void coordinator.request(request({ from: { latitude: 5.6 + index * 0.0003, longitude: -0.19 } }));
    }
    second.resolve(route(3));

    await expect(refresh).resolves.toEqual({ fetched: 2, published: 2 });
    expect(providerCalls).toBe(2);
    expect(ride.published).toHaveLength(2);
    expect(ride.published[1].request.from.latitude).toBeCloseTo(5.6075, 7);
    expect(ride.published[1].metrics.distanceKm).toBe(3);
  });

  it('does not publish or renew a route timestamp when every provider fails', async () => {
    const initial = request();
    const calculatedAt = '2026-10-17T00:00:00.000Z';
    const ride: FakeRide = {
      driverId: initial.driverId,
      phase: initial.phase,
      target: initial.target,
      targetKey: initial.targetKey,
      lease: null,
      published: [{ request: initial, metrics: route(1), calculatedAt }],
    };
    let now = Date.parse('2026-10-17T00:00:05.000Z');
    let providerCalls = 0;
    const coordinator = createLiveRouteRefreshCoordinator({
      storage: guardedStorage(ride),
      fetchRoute: async () => {
        providerCalls += 1;
        return null;
      },
      now: () => now,
      refreshMs: 8_000,
    });

    await expect(coordinator.request(initial)).resolves.toEqual({ fetched: 1, published: 0 });
    now += 100;
    // Failure backoff prevents high-rate location ingestion from calling the
    // unavailable provider again; it also leaves the old calculation untouched.
    await expect(coordinator.request(initial)).resolves.toEqual({ fetched: 0, published: 0 });

    expect(providerCalls).toBe(1);
    expect(ride.published).toEqual([{ request: initial, metrics: route(1), calculatedAt }]);
  });
});
