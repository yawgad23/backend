import { randomUUID } from 'node:crypto';
import type { Point, RoadRouteMetrics } from './liveRouteMetrics';

export type LiveRoutePhase = 'pickup' | 'destination';

/**
 * Everything below is display-routing state only. The coordinator never feeds
 * fare, trip meter, payment, or lifecycle calculations.
 */
export type LiveRouteRefreshRequest = {
  rideId: string;
  driverId: string;
  from: Point;
  target: Point;
  /** Compatibility/display key: latitude.toFixed(5) + ':' + longitude.toFixed(5). */
  targetKey: string;
  phase: LiveRoutePhase;
  targetKind: 'pickup' | 'destination' | 'stop';
};

export type LiveRouteRefreshLease = {
  token: string;
};

/**
 * The production implementation claims and publishes in Firestore
 * transactions. Tests deliberately supply a small in-memory implementation so
 * timing and stale-write policy can be proven without a database or router.
 */
export type LiveRouteRefreshStorage = {
  claim(request: LiveRouteRefreshRequest, nowMs: number): Promise<LiveRouteRefreshLease | null>;
  publish(
    request: LiveRouteRefreshRequest,
    lease: LiveRouteRefreshLease,
    metrics: RoadRouteMetrics,
    calculatedAt: string,
    nowMs: number,
  ): Promise<boolean>;
  release?(request: LiveRouteRefreshRequest, lease: LiveRouteRefreshLease, nowMs: number): Promise<void>;
};

export type LiveRouteRefreshResult = {
  /** Number of provider calls made by this scheduled run (at most one at once). */
  fetched: number;
  /** Number of transactionally accepted live-route publications. */
  published: number;
};

type PublishedRoute = {
  request: LiveRouteRefreshRequest;
  metrics: RoadRouteMetrics;
  calculatedAtMs: number;
};

type FailedRoute = {
  request: LiveRouteRefreshRequest;
  atMs: number;
};

type RideState = {
  desired: LiveRouteRefreshRequest;
  desiredRevision: number;
  running: Promise<LiveRouteRefreshResult> | null;
  lastPublished: PublishedRoute | null;
  lastFailure: FailedRoute | null;
};

export type LiveRouteRefreshCoordinatorOptions = {
  fetchRoute: (from: Point, target: Point) => Promise<RoadRouteMetrics | null>;
  storage: LiveRouteRefreshStorage;
  now?: () => number;
  /** Normal successful-route cache interval; defaults to the existing 8 seconds. */
  refreshMs?: number;
  /** Movement required to run one trailing request after a request already in flight. */
  trailingMovementMeters?: number;
  /** A server-owned road geometry can bypass the normal cache only when off path. */
  isRouteOffPath?: (from: Point, metrics: RoadRouteMetrics) => boolean;
};

function samePoint(left: Point, right: Point) {
  return left.latitude === right.latitude && left.longitude === right.longitude;
}

function sameIdentity(left: LiveRouteRefreshRequest, right: LiveRouteRefreshRequest) {
  return left.rideId === right.rideId
    && left.driverId === right.driverId
    && left.phase === right.phase
    && left.targetKind === right.targetKind
    && left.targetKey === right.targetKey
    && samePoint(left.target, right.target);
}

function distanceMeters(from: Point, to: Point) {
  const radians = (value: number) => (value * Math.PI) / 180;
  const earthRadiusMeters = 6_371_008.8;
  const latitudeDelta = radians(to.latitude - from.latitude);
  const longitudeDelta = radians(to.longitude - from.longitude);
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(from.latitude)) * Math.cos(radians(to.latitude)) * Math.sin(longitudeDelta / 2) ** 2;
  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

/**
 * Coalesces high-rate GPS samples per ride. While a provider call is running,
 * only the newest desired point is retained. Once it ends there can be only a
 * single trailing request, never one request per incoming location update.
 *
 * Firestore remains the authority: this process-local structure reduces work,
 * but its lease token is never trusted for publication without storage checks.
 */
export function createLiveRouteRefreshCoordinator(options: LiveRouteRefreshCoordinatorOptions) {
  const now = options.now || Date.now;
  const refreshMs = options.refreshMs ?? 8_000;
  const trailingMovementMeters = options.trailingMovementMeters ?? 20;
  const isRouteOffPath = options.isRouteOffPath || (() => false);
  const states = new Map<string, RideState>();

  function shouldStart(state: RideState, request: LiveRouteRefreshRequest, atMs: number) {
    const published = state.lastPublished;
    // A failed provider/storage attempt must not turn every 25 Hz GPS update
    // into another provider call. A target/phase/owner change bypasses this
    // limiter because it is a different route identity.
    if (state.lastFailure
      && sameIdentity(state.lastFailure.request, request)
      && atMs - state.lastFailure.atMs < refreshMs) return false;

    if (!published || !sameIdentity(published.request, request)) return true;

    if (atMs - published.calculatedAtMs >= refreshMs) return true;
    return isRouteOffPath(request.from, published.metrics);
  }

  function needsTrailing(current: LiveRouteRefreshRequest, desired: LiveRouteRefreshRequest) {
    if (!sameIdentity(current, desired)) return true;
    return distanceMeters(current.from, desired.from) > trailingMovementMeters;
  }

  async function releaseIfCurrent(request: LiveRouteRefreshRequest, lease: LiveRouteRefreshLease, atMs: number) {
    try {
      await options.storage.release?.(request, lease, atMs);
    } catch {
      // This is display-only work. A failed release merely lets the short lease
      // expire; it must not create an unhandled background rejection.
    }
  }

  async function run(state: RideState): Promise<LiveRouteRefreshResult> {
    const result: LiveRouteRefreshResult = { fetched: 0, published: 0 };

    // A loop is intentionally used instead of spawning follow-up promises.
    // It preserves the one-running-request invariant for a ride.
    while (result.fetched < 2) {
      const request = state.desired;
      const revision = state.desiredRevision;
      const startedAtMs = now();
      let lease: LiveRouteRefreshLease | null = null;

      try {
        lease = await options.storage.claim(request, startedAtMs);
      } catch {
        state.lastFailure = { request, atMs: now() };
        return result;
      }
      if (!lease) {
        state.lastFailure = { request, atMs: now() };
        return result;
      }

      let metrics: RoadRouteMetrics | null;
      try {
        result.fetched += 1;
        metrics = await options.fetchRoute(request.from, request.target);
      } catch {
        metrics = null;
      }

      const completedAtMs = now();
      if (!metrics) {
        state.lastFailure = { request, atMs: completedAtMs };
        await releaseIfCurrent(request, lease, completedAtMs);
        // A target/phase change deserves one immediate retry; ordinary movement
        // waits for the normal failure interval rather than hammering a failed
        // routing provider.
        if (state.desiredRevision !== revision && !sameIdentity(request, state.desired)) continue;
        return result;
      }

      let published = false;
      try {
        published = await options.storage.publish(
          request,
          lease,
          metrics,
          new Date(completedAtMs).toISOString(),
          completedAtMs,
        );
      } catch {
        published = false;
      }

      if (published) {
        result.published += 1;
        state.lastPublished = { request, metrics, calculatedAtMs: completedAtMs };
        state.lastFailure = null;
      } else {
        state.lastFailure = { request, atMs: completedAtMs };
        await releaseIfCurrent(request, lease, completedAtMs);
      }

      // If a materially newer GPS point arrived, run exactly one trailing
      // request from that latest point. The old result may publish only when
      // storage still confirms the same owner/phase/target/token.
      if (state.desiredRevision !== revision && needsTrailing(request, state.desired)) continue;
      return result;
    }
    // A continuous GPS stream must not keep this invocation alive indefinitely.
    // A following authenticated observation can start the next bounded run.
    return result;
  }

  return {
    /** Schedule a refresh or join the existing per-ride run. */
    request(request: LiveRouteRefreshRequest): Promise<LiveRouteRefreshResult> {
      const existing = states.get(request.rideId);
      const state = existing || {
        desired: request,
        desiredRevision: 0,
        running: null,
        lastPublished: null,
        lastFailure: null,
      } satisfies RideState;
      if (!existing) states.set(request.rideId, state);

      if (state.running) {
        // Keep one latest sample only. The revision lets the current runner
        // decide whether that sample needs a single trailing provider request.
        state.desired = request;
        state.desiredRevision += 1;
        return state.running;
      }

      const atMs = now();
      if (!shouldStart(state, request, atMs)) return Promise.resolve({ fetched: 0, published: 0 });

      state.desired = request;
      state.desiredRevision += 1;
      const runner = run(state);
      state.running = runner;
      void runner.then(() => {
        if (state.running === runner) state.running = null;
      });
      return runner;
    },

    /** Visible only for deterministic coordinator tests and non-production diagnostics. */
    activeRideCount() {
      return states.size;
    },
  };
}

/** Default token factory is exported for production composition, not client use. */
export function createLiveRouteLeaseToken() {
  return randomUUID();
}
