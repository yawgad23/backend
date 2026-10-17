import { FieldValue } from 'firebase-admin/firestore';
import { ADMIN_COLLECTIONS, adminFirestore, getAdminDb } from './firebaseAdmin';
import {
  createLiveRouteLeaseToken,
  createLiveRouteRefreshCoordinator,
  type LiveRoutePhase,
  type LiveRouteRefreshRequest,
  type LiveRouteRefreshStorage,
} from './liveRouteRefreshCoordinator';

export type Point = { latitude: number; longitude: number };
type RoutePoint = [number, number];
/** Firestore does not permit an array to contain another array. */
export type StoredLiveRoutePoint = { lat: number; lng: number };
type TrafficSpeed = 'NORMAL' | 'SLOW' | 'TRAFFIC_JAM';

type TrafficInterval = {
  startPointIndex: number;
  endPointIndex: number;
  speed: TrafficSpeed;
};

export type RoadRouteMetrics = {
  distanceKm: number;
  durationMinutes: number;
  points: RoutePoint[];
  source: 'google_routes_traffic' | 'osrm' | 'server_coordinate_estimate';
  traffic?: {
    staticDurationMinutes: number | null;
    delayMinutes: number | null;
    speedIntervals: TrafficInterval[];
  };
};

const ACTIVE_STATUSES = ['matched', 'driver_arriving', 'driver_arrived', 'in_progress'];
export const ROUTE_REFRESH_MS = 8_000;
// A GPS fix this far from the last server road geometry means the Driver has
// genuinely left that guidance. It is deliberately wider than normal GPS
// drift, but small enough that Riders do not keep seeing a route already missed.
export const LIVE_ROUTE_OFF_PATH_METERS = 45;
const MAX_ROUTE_POINTS = 180;
const COORDINATE_ROAD_DISTANCE_FACTOR = 1.28;
const COORDINATE_FALLBACK_SPEED_KMH = 22;
const FAST_GOOGLE_ROUTE_WAIT_MS = 1_500;
const BOOKING_ROUTE_CACHE_TTL_MS = 20_000;
const MAX_BOOKING_ROUTE_CACHE_ENTRIES = 120;
// Retained as a public tuning constant. It now governs whether a completed
// provider request needs one latest trailing refresh, not whether we spawn a
// competing request while another one is in flight.
export const PENDING_ROUTE_REUSE_METERS = 20;
type CachedBookingRoute = { expiresAt: number; metrics: RoadRouteMetrics };
const bookingRouteCache = new Map<string, CachedBookingRoute>();
const bookingRouteInFlight = new Map<string, Promise<RoadRouteMetrics | null>>();
/** A short per-ride Firestore lease bounds duplicate work across backend instances. */
export const LIVE_ROUTE_LEASE_MS = 12_000;

function validPoint(point: Point | null | undefined): point is Point {
  return Boolean(
    point
    && Number.isFinite(point.latitude)
    && Number.isFinite(point.longitude)
    && point.latitude >= -90 && point.latitude <= 90
    && point.longitude >= -180 && point.longitude <= 180,
  );
}

function validRoutePoint(point: unknown): point is RoutePoint {
  return Array.isArray(point)
    && point.length >= 2
    && Number.isFinite(Number(point[0]))
    && Number.isFinite(Number(point[1]))
    && Math.abs(Number(point[0])) <= 90
    && Math.abs(Number(point[1])) <= 180;
}

/**
 * Measures the nearest point on a server-owned route. This is display routing
 * only: it decides when to request a newer line and never affects the fare,
 * trip meter, or settlement.
 */
export function liveRouteOffPathMeters(from: Point, routePoints: RoutePoint[]): number | null {
  if (!validPoint(from)) return null;
  const route = routePoints.filter(validRoutePoint);
  if (route.length < 2) return null;

  const latitudeScale = (Math.PI * 6_371_000) / 180;
  const longitudeScale = latitudeScale * Math.cos((from.latitude * Math.PI) / 180);
  const toLocal = (point: RoutePoint): [number, number] => [
    (point[1] - from.longitude) * longitudeScale,
    (point[0] - from.latitude) * latitudeScale,
  ];

  let nearest = Number.POSITIVE_INFINITY;
  for (let index = 0; index < route.length - 1; index += 1) {
    const [startX, startY] = toLocal(route[index]);
    const [endX, endY] = toLocal(route[index + 1]);
    const deltaX = endX - startX;
    const deltaY = endY - startY;
    const squaredLength = deltaX * deltaX + deltaY * deltaY;
    if (squaredLength < 0.01) continue;
    const progress = Math.max(0, Math.min(1, -(startX * deltaX + startY * deltaY) / squaredLength));
    const closestX = startX + deltaX * progress;
    const closestY = startY + deltaY * progress;
    nearest = Math.min(nearest, Math.hypot(closestX, closestY));
  }

  return Number.isFinite(nearest) ? nearest : null;
}

function greatCircleDistanceKm(from: Point, to: Point): number {
  const radians = (value: number) => (value * Math.PI) / 180;
  const earthRadiusKm = 6371.0088;
  const latDelta = radians(to.latitude - from.latitude);
  const lngDelta = radians(to.longitude - from.longitude);
  const fromLatitude = radians(from.latitude);
  const toLatitude = radians(to.latitude);
  const haversine = Math.sin(latDelta / 2) ** 2
    + Math.cos(fromLatitude) * Math.cos(toLatitude) * Math.sin(lngDelta / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

/**
 * Gives a booking an explicitly-labelled, server-only estimate when every
 * external road router is unavailable. It accepts neither a device distance
 * nor a device duration, and returns no geometry so the native map never
 * draws a misleading straight line in place of a road route.
 */
export function serverCoordinateRouteEstimate(from: Point, destinations: Point[]): RoadRouteMetrics | null {
  if (!validPoint(from) || destinations.length === 0 || destinations.some((point) => !validPoint(point))) return null;
  let origin = from;
  let directDistanceKm = 0;
  for (const destination of destinations) {
    directDistanceKm += greatCircleDistanceKm(origin, destination);
    origin = destination;
  }
  if (!Number.isFinite(directDistanceKm) || directDistanceKm <= 0) return null;
  const distanceKm = directDistanceKm * COORDINATE_ROAD_DISTANCE_FACTOR;
  return {
    distanceKm: Number(distanceKm.toFixed(3)),
    durationMinutes: Number(Math.max(1, (distanceKm / COORDINATE_FALLBACK_SPEED_KMH) * 60).toFixed(1)),
    points: [],
    source: 'server_coordinate_estimate',
  };
}

function pointFrom(value: any): Point | null {
  const latitude = Number(value?.latitude ?? value?.lat);
  const longitude = Number(value?.longitude ?? value?.lng);
  const point = { latitude, longitude };
  return validPoint(point) ? point : null;
}

/**
 * A route target may override the final destination only when it is the exact
 * server-recorded, still-pending in-trip stop. Older documents can contain a
 * loose `route_target.location` left by a retired flow; that must never become
 * navigation authority for a live Driver trip.
 */
type VerifiedPendingStop = { id: string; point: Point; location: Record<string, any> };

function verifiedPendingStop(ride: Record<string, any>): VerifiedPendingStop | null {
  const target = ride.route_target;
  if (!target || typeof target !== 'object' || target.kind !== 'stop') return null;
  const stopId = String(target.stop_id || '').trim();
  if (!stopId || !Array.isArray(ride.in_trip_stops)) return null;

  const matchingStop = ride.in_trip_stops.find((stop: any) => stop
    && typeof stop === 'object'
    && String(stop.id || '').trim() === stopId
    && String(stop.status || '').trim().toLowerCase() === 'pending');
  const stopPoint = pointFrom(matchingStop);
  const targetPoint = pointFrom(target.location);
  if (!stopPoint || !targetPoint) return null;

  // The target object is only a reference to the server-owned stop. Require
  // exact normalized coordinates before allowing it to replace destination.
  return stopPoint.latitude === targetPoint.latitude && stopPoint.longitude === targetPoint.longitude
    ? { id: stopId, point: stopPoint, location: matchingStop }
    : null;
}

function verifiedPendingStopTarget(ride: Record<string, any>): Point | null {
  return verifiedPendingStop(ride)?.point || null;
}

function canonicalLocation(value: any, point: Point) {
  const name = typeof value?.name === 'string' ? value.name : typeof value?.address === 'string' ? value.address : '';
  const address = typeof value?.address === 'string' ? value.address : name;
  return { ...(name ? { name } : {}), ...(address ? { address } : {}), lat: point.latitude, lng: point.longitude };
}

/**
 * Canonical target representation for the currently active in-progress trip.
 * This deliberately treats a destination-shaped or malformed legacy target as
 * destination: only a verified pending stop can be authoritative.
 */
export function canonicalLiveRouteTarget(ride: Record<string, any>): Record<string, any> | null {
  if (String(ride.status || '').trim().toLowerCase() !== 'in_progress') return null;
  const stop = verifiedPendingStop(ride);
  if (stop) return { kind: 'stop', stop_id: stop.id, location: canonicalLocation(stop.location, stop.point) };
  const destination = pointFrom(ride.destination);
  return destination ? { kind: 'destination', location: canonicalLocation(ride.destination, destination) } : null;
}

function targetNeedsCanonicalization(current: any, canonical: Record<string, any> | null) {
  if (!canonical) return false;
  const currentPoint = pointFrom(current?.location);
  const canonicalPoint = pointFrom(canonical.location);
  return !currentPoint
    || !canonicalPoint
    || String(current?.kind || '') !== String(canonical.kind || '')
    || String(current?.stop_id || '') !== String(canonical.stop_id || '')
    || currentPoint.latitude !== canonicalPoint.latitude
    || currentPoint.longitude !== canonicalPoint.longitude;
}

export function liveRouteTarget(ride: Record<string, any>): Point | null {
  if (String(ride.status) !== 'in_progress') return pointFrom(ride.pickup);
  // Only a verified pending stop may replace the real destination. This keeps
  // legacy or malformed target metadata from sending a Driver to a wrong pin.
  return verifiedPendingStopTarget(ride) || pointFrom(ride.destination);
}

export function routeTargetKey(to: Point) {
  return [to.latitude, to.longitude]
    .map((value) => Number(value).toFixed(5))
    .join(':');
}

/** Reuse only same-destination guidance; a pickup-to-trip phase change must route immediately. */
export function shouldReuseCachedRoute(
  previous: ({ requestedAt: number; targetKey: string } & {
    metrics?: RoadRouteMetrics | null;
    requestedFrom?: Point;
    inFlight?: boolean;
  }) | undefined,
  targetKey: string,
  now: number,
  from?: Point,
): boolean {
  if (!previous || previous.targetKey !== targetKey || now - previous.requestedAt >= ROUTE_REFRESH_MS) return false;

  // This helper now describes only completed-route cache eligibility. In-flight
  // work is coalesced by the per-ride coordinator below, which keeps one
  // running provider call and one latest trailing sample instead of creating a
  // new request for every GPS update.
  if (previous.inFlight) {
    return false;
  }

  // Do not hold an eight-second cache window after the Driver has passed the
  // server road line. A fresh road route is then requested by the very next
  // authenticated GPS upload, rather than leaving a misleading green line on
  // the Rider map until the normal timer expires.
  const offPathMeters = from && previous.metrics
    ? liveRouteOffPathMeters(from, previous.metrics.points)
    : null;
  return offPathMeters === null || offPathMeters <= LIVE_ROUTE_OFF_PATH_METERS;
}

/** A late routing response must never overwrite a newer GPS route request. */
export function isCurrentRouteRefresh(currentRequestId: number | undefined, completedRequestId: number) {
  return Number.isInteger(currentRequestId)
    && Number.isInteger(completedRequestId)
    && currentRequestId === completedRequestId;
}

function boundedRoutePoints(points: RoutePoint[]): RoutePoint[] {
  if (points.length <= MAX_ROUTE_POINTS) return points;
  const step = (points.length - 1) / (MAX_ROUTE_POINTS - 1);
  return Array.from({ length: MAX_ROUTE_POINTS }, (_, index) => points[Math.round(index * step)]);
}

/**
 * Road providers use compact tuple coordinates in memory, but those tuples
 * cannot be written to Firestore as a nested array. Persist a small map for
 * each point and let native clients convert it back to a tuple for drawing.
 */
export function firestoreSafeLiveRoutePoints(points: RoutePoint[]): StoredLiveRoutePoint[] {
  return boundedRoutePoints(points)
    .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180)
    .map(([lat, lng]) => ({ lat, lng }));
}

function durationMinutes(value: unknown): number | null {
  const seconds = Number(String(value || '').match(/^([0-9.]+)s$/)?.[1]);
  return Number.isFinite(seconds) && seconds >= 0 ? Number((seconds / 60).toFixed(1)) : null;
}

/** Decodes Google's Encoded Polyline Algorithm Format to [latitude, longitude] points. */
export function decodeGooglePolyline(encoded: unknown): RoutePoint[] {
  if (typeof encoded !== 'string' || !encoded) return [];
  const points: RoutePoint[] = [];
  let index = 0;
  let latitude = 0;
  let longitude = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte = 0;
    do {
      if (index >= encoded.length) return [];
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    latitude += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      if (index >= encoded.length) return [];
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    longitude += result & 1 ? ~(result >> 1) : result >> 1;

    points.push([latitude / 1e5, longitude / 1e5]);
  }

  return points.filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));
}

function trafficIntervals(value: unknown): TrafficInterval[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((interval: any) => ({
      startPointIndex: Math.max(0, Math.floor(Number(interval?.startPolylinePointIndex ?? 0))),
      endPointIndex: Math.max(0, Math.floor(Number(interval?.endPolylinePointIndex ?? 0))),
      speed: interval?.speed as TrafficSpeed,
    }))
    .filter((interval) => interval.endPointIndex > interval.startPointIndex && ['NORMAL', 'SLOW', 'TRAFFIC_JAM'].includes(interval.speed));
}

/** Parses a traffic-aware Google Routes API response without retaining the API key. */
export function parseGoogleTrafficRoute(body: any): RoadRouteMetrics | null {
  const route = body?.routes?.[0];
  const distanceKm = Number(route?.distanceMeters) / 1000;
  const routeDurationMinutes = durationMinutes(route?.duration);
  if (!Number.isFinite(distanceKm) || distanceKm < 0 || routeDurationMinutes === null) return null;

  const staticDurationMinutes = durationMinutes(route?.staticDuration);
  const delayMinutes = staticDurationMinutes === null
    ? null
    : Number(Math.max(0, routeDurationMinutes - staticDurationMinutes).toFixed(1));

  return {
    distanceKm: Number(distanceKm.toFixed(3)),
    durationMinutes: routeDurationMinutes,
    points: boundedRoutePoints(decodeGooglePolyline(route?.polyline?.encodedPolyline)),
    source: 'google_routes_traffic',
    traffic: {
      staticDurationMinutes,
      delayMinutes,
      speedIntervals: trafficIntervals(route?.travelAdvisory?.speedReadingIntervals),
    },
  };
}

/** Converts OSRM GeoJSON coordinates ([lng, lat]) to the app's [lat, lng]. */
export function parseOsrmRoute(body: any): RoadRouteMetrics | null {
  const route = body?.routes?.[0];
  const distanceKm = Number(route?.distance) / 1000;
  const routeDurationMinutes = Number(route?.duration) / 60;
  if (!Number.isFinite(distanceKm) || distanceKm < 0 || !Number.isFinite(routeDurationMinutes) || routeDurationMinutes < 0) return null;

  const coordinates = Array.isArray(route?.geometry?.coordinates) ? route.geometry.coordinates : [];
  const points = coordinates
    .filter((coordinate: any) => Array.isArray(coordinate) && coordinate.length >= 2)
    .map((coordinate: any) => [Number(coordinate[1]), Number(coordinate[0])] as RoutePoint)
    .filter(([latitude, longitude]: RoutePoint) => Number.isFinite(latitude) && Number.isFinite(longitude));

  return {
    distanceKm: Number(distanceKm.toFixed(3)),
    durationMinutes: Number(routeDurationMinutes.toFixed(1)),
    points: boundedRoutePoints(points),
    source: 'osrm',
  };
}

/**
 * Uses the server-only Maps key. `TRAFFIC_AWARE` changes the returned duration
 * with live traffic; `TRAFFIC_ON_POLYLINE` additionally returns speed intervals
 * that can be rendered by a future native map layer. No client ever receives
 * the Maps key.
 */
export async function fetchGoogleTrafficRoute(from: Point, to: Point): Promise<RoadRouteMetrics | null> {
  const apiKey = String(process.env.GOOGLE_MAPS_API_KEY || '').trim();
  if (!apiKey) return null;

  try {
    const response = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      signal: AbortSignal.timeout(4_000),
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey,
        'x-goog-fieldmask': 'routes.duration,routes.staticDuration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.travelAdvisory.speedReadingIntervals',
      },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: from.latitude, longitude: from.longitude } } },
        destination: { location: { latLng: { latitude: to.latitude, longitude: to.longitude } } },
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_AWARE',
        extraComputations: ['TRAFFIC_ON_POLYLINE'],
        computeAlternativeRoutes: false,
        polylineQuality: 'OVERVIEW',
        polylineEncoding: 'ENCODED_POLYLINE',
        languageCode: 'en-GH',
        units: 'METRIC',
      }),
    });
    if (!response.ok) return null;
    return parseGoogleTrafficRoute(await response.json().catch(() => null));
  } catch {
    return null;
  }
}

async function fetchOsrmRoadRoute(from: Point, to: Point): Promise<RoadRouteMetrics | null> {
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${from.longitude},${from.latitude};${to.longitude},${to.latitude}?overview=full&geometries=geojson&steps=false`;
    const response = await fetch(url, { signal: AbortSignal.timeout(4_000) });
    if (!response.ok) return null;
    return parseOsrmRoute(await response.json().catch(() => null));
  } catch {
    return null;
  }
}

/**
 * Keep traffic-aware Google routing as the first preference, but do not wait
 * for its full timeout before an already-started road-route fallback can answer
 * a booking screen. Both providers remain server-only and the server remains
 * the authority for the returned distance and duration.
 */
export async function preferGoogleRouteWithFastFallback(
  googleRoute: Promise<RoadRouteMetrics | null>,
  osrmRoute: Promise<RoadRouteMetrics | null>,
  googleWaitMs = FAST_GOOGLE_ROUTE_WAIT_MS,
): Promise<RoadRouteMetrics | null> {
  const fastGoogleResult = await Promise.race<RoadRouteMetrics | null>([
    googleRoute,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), googleWaitMs)),
  ]);
  if (fastGoogleResult) return fastGoogleResult;

  const fallbackResult = await osrmRoute;
  return fallbackResult || await googleRoute;
}

/** Prefers commercial live-traffic routing, while preserving the normal road fallback. */
export async function fetchRoadRoute(from: Point, to: Point): Promise<RoadRouteMetrics | null> {
  return await fetchGoogleTrafficRoute(from, to) || await fetchOsrmRoadRoute(from, to);
}

/**
 * Joins the server-calculated road legs used by a booking preview. This is the
 * same commercial-route-first policy used during an active trip, so the Rider
 * never sees a straight line as if it were a road recommendation.
 */
export async function fetchRoadRouteWithStops(from: Point, destinations: Point[]): Promise<RoadRouteMetrics | null> {
  if (!validPoint(from) || destinations.length === 0 || destinations.some((point) => !validPoint(point))) return null;
  let origin = from;
  const legs: RoadRouteMetrics[] = [];
  for (const destination of destinations) {
    const leg = await fetchRoadRoute(origin, destination);
    // Quote availability must not depend on a third-party road router. The
    // server keeps fare authority by creating a bounded estimate itself, and
    // empty geometry ensures the map cannot portray it as a road line.
    if (!leg) return serverCoordinateRouteEstimate(from, destinations);
    legs.push(leg);
    origin = destination;
  }
  const points = boundedRoutePoints(legs.flatMap((leg, index) => index === 0 ? leg.points : leg.points.slice(1)));
  if (points.length < 2) return null;
  const allGoogle = legs.every((leg) => leg.source === 'google_routes_traffic');
  const staticDuration = legs.reduce((sum, leg) => sum + Number(leg.traffic?.staticDurationMinutes || 0), 0);
  const delay = legs.reduce((sum, leg) => sum + Number(leg.traffic?.delayMinutes || 0), 0);
  return {
    distanceKm: Number(legs.reduce((sum, leg) => sum + leg.distanceKm, 0).toFixed(3)),
    durationMinutes: Number(legs.reduce((sum, leg) => sum + leg.durationMinutes, 0).toFixed(1)),
    points,
    source: allGoogle ? 'google_routes_traffic' : 'osrm',
    traffic: allGoogle ? {
      staticDurationMinutes: Number(staticDuration.toFixed(1)),
      delayMinutes: Number(delay.toFixed(1)),
      speedIntervals: [],
    } : undefined,
  };
}

/** A quicker booking-only route path; active-trip live ETA keeps its traffic-first path above. */
async function fetchFastBookingRoadRouteWithStops(from: Point, destinations: Point[]): Promise<RoadRouteMetrics | null> {
  if (!validPoint(from) || destinations.length === 0 || destinations.some((point) => !validPoint(point))) return null;
  let origin = from;
  const legs: RoadRouteMetrics[] = [];
  for (const destination of destinations) {
    const leg = await preferGoogleRouteWithFastFallback(
      fetchGoogleTrafficRoute(origin, destination),
      fetchOsrmRoadRoute(origin, destination),
    );
    if (!leg) return serverCoordinateRouteEstimate(from, destinations);
    legs.push(leg);
    origin = destination;
  }
  const points = boundedRoutePoints(legs.flatMap((leg, index) => index === 0 ? leg.points : leg.points.slice(1)));
  if (points.length < 2) return serverCoordinateRouteEstimate(from, destinations);
  const allGoogle = legs.every((leg) => leg.source === 'google_routes_traffic');
  const staticDuration = legs.reduce((sum, leg) => sum + Number(leg.traffic?.staticDurationMinutes || 0), 0);
  const delay = legs.reduce((sum, leg) => sum + Number(leg.traffic?.delayMinutes || 0), 0);
  return {
    distanceKm: Number(legs.reduce((sum, leg) => sum + leg.distanceKm, 0).toFixed(3)),
    durationMinutes: Number(legs.reduce((sum, leg) => sum + leg.durationMinutes, 0).toFixed(1)),
    points,
    source: allGoogle ? 'google_routes_traffic' : 'osrm',
    traffic: allGoogle ? {
      staticDurationMinutes: Number(staticDuration.toFixed(1)),
      delayMinutes: Number(delay.toFixed(1)),
      speedIntervals: [],
    } : undefined,
  };
}

/** Stable key for short-lived, coordinate-identical booking previews only. */
export function bookingRouteCacheKey(from: Point, destinations: Point[]) {
  const pointKey = (point: Point) => `${point.latitude.toFixed(5)},${point.longitude.toFixed(5)}`;
  return [pointKey(from), ...destinations.map(pointKey)].join('~');
}

function pruneBookingRouteCache(now: number) {
  for (const [key, cached] of bookingRouteCache) {
    if (cached.expiresAt <= now) bookingRouteCache.delete(key);
  }
  while (bookingRouteCache.size >= MAX_BOOKING_ROUTE_CACHE_ENTRIES) {
    const oldestKey = bookingRouteCache.keys().next().value;
    if (!oldestKey) break;
    bookingRouteCache.delete(oldestKey);
  }
}

/**
 * Reuses an identical route calculation for a brief quote-comparison window.
 * This coalesces the Rider's selected-category request and background-category
 * request without sharing any fare, quote ID, or Rider-owned data.
 */
export async function fetchBookingRoadRouteWithStops(from: Point, destinations: Point[]): Promise<RoadRouteMetrics | null> {
  if (!validPoint(from) || destinations.length === 0 || destinations.some((point) => !validPoint(point))) return null;
  const key = bookingRouteCacheKey(from, destinations);
  const now = Date.now();
  const cached = bookingRouteCache.get(key);
  if (cached && cached.expiresAt > now) return cached.metrics;
  pruneBookingRouteCache(now);

  const existing = bookingRouteInFlight.get(key);
  if (existing) return existing;

  const request = fetchFastBookingRoadRouteWithStops(from, destinations).then((metrics) => {
    if (metrics) bookingRouteCache.set(key, { metrics, expiresAt: Date.now() + BOOKING_ROUTE_CACHE_TTL_MS });
    return metrics;
  });
  bookingRouteInFlight.set(key, request);
  try {
    return await request;
  } finally {
    if (bookingRouteInFlight.get(key) === request) bookingRouteInFlight.delete(key);
  }
}

function activeRoutePhase(ride: Record<string, any>): LiveRoutePhase | null {
  const status = String(ride.status || '').trim().toLowerCase();
  if (status === 'in_progress') return 'destination';
  return ACTIVE_STATUSES.includes(status) ? 'pickup' : null;
}

function liveRouteTargetKind(ride: Record<string, any>, phase: LiveRoutePhase): 'pickup' | 'destination' | 'stop' {
  return phase === 'destination' && verifiedPendingStopTarget(ride) ? 'stop' : phase;
}

/**
 * Coordinate equality is intentional here. The request target originated from
 * the stored ride and this comparison happens inside the write transaction,
 * so even a small stop/destination edit invalidates an old route response.
 * `target_key` remains the five-decimal mobile-compatible display identity.
 */
function sameLiveRouteTarget(left: Point | null, right: Point) {
  return Boolean(left && left.latitude === right.latitude && left.longitude === right.longitude);
}

function leaseExpiresAtMs(value: unknown) {
  const result = new Date(String(value || '')).getTime();
  return Number.isFinite(result) ? result : 0;
}

function leaseMatchesRequest(lease: any, request: LiveRouteRefreshRequest) {
  return lease
    && String(lease.driver_id || '') === request.driverId
    && String(lease.phase || '') === request.phase
    && String(lease.target_kind || '') === request.targetKind
    && String(lease.target_key || '') === request.targetKey
    && Number(lease.target_latitude) === request.target.latitude
    && Number(lease.target_longitude) === request.target.longitude;
}

function currentRideMatchesRequest(ride: Record<string, any>, request: LiveRouteRefreshRequest) {
  return String(ride.driver_id || '') === request.driverId
    && activeRoutePhase(ride) === request.phase
    && liveRouteTargetKind(ride, request.phase) === request.targetKind
    && sameLiveRouteTarget(liveRouteTarget(ride), request.target)
    && routeTargetKey(liveRouteTarget(ride) as Point) === request.targetKey;
}

function liveRouteSource(source: RoadRouteMetrics['source']) {
  return source === 'google_routes_traffic'
    ? 'server_google_routes_traffic'
    : source === 'osrm'
      ? 'server_osrm_road_route_fallback'
      : 'server_coordinate_route_estimate';
}

function liveRouteLease(request: LiveRouteRefreshRequest, token: string, expiresAtMs: number, extra: Record<string, unknown> = {}) {
  return {
    token,
    driver_id: request.driverId,
    phase: request.phase,
    target_kind: request.targetKind,
    target_key: request.targetKey,
    target_latitude: request.target.latitude,
    target_longitude: request.target.longitude,
    expires_at: new Date(expiresAtMs).toISOString(),
    ...extra,
  };
}

/**
 * This is the cross-instance authority for a display-route refresh. A local
 * coordinator saves provider work, but only this transaction decides whether a
 * response belongs to the currently assigned Driver, phase, exact target, and
 * current lease token. It intentionally does not change lifecycle or fare
 * fields.
 */
export const firestoreLiveRouteRefreshStorage: LiveRouteRefreshStorage = {
  async claim(request, nowMs) {
    const db = getAdminDb();
    const ref = db.collection(ADMIN_COLLECTIONS.RIDES).doc(request.rideId);
    const token = createLiveRouteLeaseToken();
    return await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(ref);
      if (!snap.exists) return null;
      const ride = { id: snap.id, ...(snap.data() || {}) } as Record<string, any>;
      if (!currentRideMatchesRequest(ride, request)) return null;

      const existing = ride.live_route_refresh_lease;
      // A different owner/phase/target takes over immediately and invalidates
      // the old token. Matching work is coalesced across Cloud Run instances
      // for the short lease period.
      if (leaseMatchesRequest(existing, request)
        && !existing?.completed_at
        && leaseExpiresAtMs(existing?.expires_at) > nowMs) return null;

      const canonicalTarget = canonicalLiveRouteTarget(ride);
      transaction.update(ref, {
        ...(targetNeedsCanonicalization(ride.route_target, canonicalTarget) ? { route_target: canonicalTarget } : {}),
        live_route_refresh_lease: liveRouteLease(request, token, nowMs + LIVE_ROUTE_LEASE_MS, {
          claimed_at: new Date(nowMs).toISOString(),
          server_claimed_at: FieldValue.serverTimestamp(),
        }),
      });
      return { token };
    });
  },

  async publish(request, lease, metrics, calculatedAt, nowMs) {
    const db = getAdminDb();
    const ref = db.collection(ADMIN_COLLECTIONS.RIDES).doc(request.rideId);
    return await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(ref);
      if (!snap.exists) return false;
      const ride = { id: snap.id, ...(snap.data() || {}) } as Record<string, any>;
      const activeLease = ride.live_route_refresh_lease;
      if (!currentRideMatchesRequest(ride, request)
        || !leaseMatchesRequest(activeLease, request)
        || leaseExpiresAtMs(activeLease?.expires_at) <= nowMs
        || String(activeLease?.token || '') !== lease.token) return false;

      // `calculated_at` is the completion time of this actual provider result,
      // not the time a later GPS update noticed a cached/fallback value. There
      // is deliberately no cached metrics fallback in the coordinator.
      transaction.update(ref, {
        live_route_metrics: {
          distance_km: metrics.distanceKm,
          duration_minutes: metrics.durationMinutes,
          phase: request.phase,
          points: firestoreSafeLiveRoutePoints(metrics.points),
          source: metrics.source,
          target_kind: request.targetKind,
          target_key: request.targetKey,
          calculated_at: calculatedAt,
          // Existing clients read this legacy field; keep it equal to the real
          // calculation time rather than republishing stale data as fresh.
          updated_at: calculatedAt,
          server_published_at: FieldValue.serverTimestamp(),
          traffic: metrics.traffic || null,
        },
        route_distance_source: liveRouteSource(metrics.source),
        // The in-flight lease is consumed by this same atomic publication. A
        // local coordinator provides the normal 8-second cache; releasing here
        // lets the latest coalesced sample acquire a new token when it really
        // needs an immediate trailing route after a material movement.
        live_route_refresh_lease: FieldValue.delete(),
      });
      return true;
    });
  },

  async release(request, lease) {
    const db = getAdminDb();
    const ref = db.collection(ADMIN_COLLECTIONS.RIDES).doc(request.rideId);
    await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(ref);
      if (!snap.exists) return;
      const activeLease = (snap.data() || {}).live_route_refresh_lease;
      if (leaseMatchesRequest(activeLease, request) && String(activeLease?.token || '') === lease.token) {
        transaction.update(ref, { live_route_refresh_lease: FieldValue.delete() });
      }
    });
  },
};

const liveRouteRefreshCoordinator = createLiveRouteRefreshCoordinator({
  fetchRoute: fetchRoadRoute,
  storage: firestoreLiveRouteRefreshStorage,
  refreshMs: ROUTE_REFRESH_MS,
  trailingMovementMeters: PENDING_ROUTE_REUSE_METERS,
  isRouteOffPath: (from, metrics) => {
    const offPathMeters = liveRouteOffPathMeters(from, metrics.points);
    return offPathMeters !== null && offPathMeters > LIVE_ROUTE_OFF_PATH_METERS;
  },
});

/**
 * Refreshes route metrics for every active ride assigned to a Driver. The
 * backend writes all distance, duration, geometry, and traffic values; clients
 * only render the persisted values and cannot influence payment authority.
 */
export async function refreshDriverActiveRideRoutes(driverId: string, driverLocation: Point) {
  if (!driverId || !validPoint(driverLocation)) return { attempted: 0, updated: 0 };
  const rides = (await Promise.all(
    ACTIVE_STATUSES.map((status) => adminFirestore.list(ADMIN_COLLECTIONS.RIDES, { driver_id: driverId, status }, null, 'desc', 3)),
  )).flat();

  const refreshes = await Promise.all(rides.map(async (ride) => {
    const rideId = String(ride.id || '');
    const target = liveRouteTarget(ride);
    const phase = activeRoutePhase(ride);
    if (!rideId || !target || !phase) return { fetched: 0, published: 0 };
    return await liveRouteRefreshCoordinator.request({
      rideId,
      driverId,
      from: driverLocation,
      target,
      targetKey: routeTargetKey(target),
      phase,
      targetKind: liveRouteTargetKind(ride, phase),
    });
  }));

  return { attempted: rides.length, updated: refreshes.reduce((sum, refresh) => sum + refresh.published, 0) };
}
