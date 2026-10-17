import { describe, it, expect, vi } from 'vitest';
import { FieldValue } from 'firebase-admin/firestore';
import type { LiveRouteRefreshRequest } from './liveRouteRefreshCoordinator';

const mock = vi.hoisted(() => ({ db: null as any }));
vi.mock('./firebaseAdmin', () => ({ getAdminDb: () => mock.db, ADMIN_COLLECTIONS: { RIDES: 'rides' }, adminFirestore: {} }));
import { firestoreLiveRouteRefreshStorage } from './liveRouteMetrics';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

// Small optimistic-transaction emulator: if a read document changes before
// commit, the same callback reruns against the new snapshot, like Firestore.
function database(initial: any) {
  let ride = structuredClone(initial);
  let version = 0;
  let pauseNextRead: (() => Promise<void>) | null = null;
  const db = {
    collection: () => ({ doc: () => ({ id: 'ride-1' }) }),
    async runTransaction(operation: (transaction: any) => Promise<any>) {
      for (let attempt = 0; attempt < 6; attempt++) {
        let observed = -1;
        let patch: any = null;
        const result = await operation({
          get: async () => {
            observed = version;
            const snapshot = { exists: true, id: 'ride-1', data: () => structuredClone(ride) };
            // Capture the data at read time, not when data() is later called.
            const captured = structuredClone(ride);
            snapshot.data = () => captured;
            const wait = pauseNextRead;
            pauseNextRead = null;
            if (wait) await wait();
            return snapshot;
          },
          update: (_ref: any, value: any) => { patch = value; },
        });
        if (observed !== version) continue;
        if (patch) {
          for (const [key, value] of Object.entries(patch)) {
            if (value instanceof FieldValue && value.isEqual(FieldValue.delete())) delete ride[key];
            else ride[key] = value;
          }
          version++;
        }
        return result;
      }
      throw new Error('Transaction retries exhausted');
    },
  };
  return { db, data: () => ride, replace: (patch: any) => { ride = { ...ride, ...patch }; version++; },
    pauseRead: (wait: () => Promise<void>) => { pauseNextRead = wait; } };
}

const request: LiveRouteRefreshRequest = { rideId: 'ride-1', driverId: 'driver-1', phase: 'destination', targetKind: 'destination',
  from: { latitude: 5.7, longitude: -0.1 }, target: { latitude: 5.71, longitude: -0.09 }, targetKey: '5.71000:-0.09000' };
const metrics = { distanceKm: 1, durationMinutes: 3, points: [[5.7, -0.1], [5.71, -0.09]] as [number, number][], source: 'osrm' as const };
const initialRide = () => ({ driver_id: 'driver-1', status: 'in_progress', destination: { lat: 5.71, lng: -0.09 } });

describe('production live route Firestore adapter', () => {
  it('publishes only with a matching current owner, phase, target, and lease', async () => {
    const storage = database(initialRide()); mock.db = storage.db;
    const lease = await firestoreLiveRouteRefreshStorage.claim(request, 100_000);
    expect(lease).not.toBeNull();
    expect(await firestoreLiveRouteRefreshStorage.publish(request, lease!, metrics, '2026-10-17T00:00:00Z', 101_000)).toBe(true);
    expect(storage.data().live_route_metrics.target_key).toBe(request.targetKey);
    expect(storage.data().live_route_metrics.updated_at).toBe('2026-10-17T00:00:00Z');
    expect(storage.data().live_route_refresh_lease).toBeUndefined();
    expect(await firestoreLiveRouteRefreshStorage.publish(request, lease!, metrics, '2026-10-17T00:00:01Z', 102_000)).toBe(false);
  });
  it('rejects expired leases and completed trips without writing a route', async () => {
    const storage = database(initialRide()); mock.db = storage.db;
    const lease = await firestoreLiveRouteRefreshStorage.claim(request, 100_000);
    expect(await firestoreLiveRouteRefreshStorage.publish(request, lease!, metrics, '2026-10-17T00:00:00Z', 113_000)).toBe(false);
    storage.replace({ status: 'completed' });
    expect(await firestoreLiveRouteRefreshStorage.publish(request, lease!, metrics, '2026-10-17T00:00:00Z', 101_000)).toBe(false);
    expect(storage.data().live_route_metrics).toBeUndefined();
  });
  it('retries and rejects a delayed old write after a same-phase destination change', async () => {
    const storage = database(initialRide()); mock.db = storage.db;
    const oldLease = await firestoreLiveRouteRefreshStorage.claim(request, 100_000);
    const blocked = deferred(); const readStarted = deferred();
    storage.pauseRead(async () => { readStarted.resolve(); await blocked.promise; });
    const oldWrite = firestoreLiveRouteRefreshStorage.publish(request, oldLease!, metrics, '2026-10-17T00:00:00Z', 101_000);
    await readStarted.promise;
    const newRequest = { ...request, target: { latitude: 5.72, longitude: -0.08 }, targetKey: '5.72000:-0.08000' };
    storage.replace({ destination: { lat: 5.72, lng: -0.08 } });
    const newLease = await firestoreLiveRouteRefreshStorage.claim(newRequest, 101_000);
    expect(await firestoreLiveRouteRefreshStorage.publish(newRequest, newLease!, metrics, '2026-10-17T00:00:01Z', 102_000)).toBe(true);
    blocked.resolve();
    expect(await oldWrite).toBe(false);
    expect(storage.data().live_route_metrics.target_key).toBe('5.72000:-0.08000');
    expect(storage.data().live_route_metrics.calculated_at).toBe('2026-10-17T00:00:01Z');
  });
  it('cannot restore an older GPS route after a newer same-target lease has published', async () => {
    const storage = database(initialRide()); mock.db = storage.db;
    const oldLease = await firestoreLiveRouteRefreshStorage.claim(request, 100_000);
    const blocked = deferred(); const readStarted = deferred();
    storage.pauseRead(async () => { readStarted.resolve(); await blocked.promise; });
    const oldWrite = firestoreLiveRouteRefreshStorage.publish(request, oldLease!, metrics, '2026-10-17T00:00:00Z', 101_000);
    await readStarted.promise;
    const newRequest = { ...request, from: { latitude: 5.705, longitude: -0.095 } };
    const newLease = await firestoreLiveRouteRefreshStorage.claim(newRequest, 113_000);
    expect(newLease).not.toBeNull();
    expect(await firestoreLiveRouteRefreshStorage.publish(newRequest, newLease!, { ...metrics, distanceKm: 0.5 }, '2026-10-17T00:00:13Z', 114_000)).toBe(true);
    blocked.resolve();
    expect(await oldWrite).toBe(false);
    expect(storage.data().live_route_metrics.distance_km).toBe(0.5);
    expect(storage.data().live_route_metrics.calculated_at).toBe('2026-10-17T00:00:13Z');
  });
  it('rejects a changed Driver assignment even when the destination is identical', async () => {
    const storage = database(initialRide()); mock.db = storage.db;
    const lease = await firestoreLiveRouteRefreshStorage.claim(request, 100_000);
    storage.replace({ driver_id: 'driver-2' });
    expect(await firestoreLiveRouteRefreshStorage.publish(request, lease!, metrics, '2026-10-17T00:00:00Z', 101_000)).toBe(false);
    expect(storage.data().live_route_metrics).toBeUndefined();
  });
});
