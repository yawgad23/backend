import { ADMIN_COLLECTIONS, adminFirestore } from './firebaseAdmin';

type Point = { latitude: number; longitude: number };
type RoutePoint = [number, number];
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
  source: 'google_routes_traffic' | 'osrm';
  traffic?: {
    staticDurationMinutes: number | null;
    delayMinutes: number | null;
    speedIntervals: TrafficInterval[];
  };
};

const ACTIVE_STATUSES = ['matched', 'driver_arriving', 'driver_arrived', 'in_progress'];
const ROUTE_REFRESH_MS = 12_000;
const MAX_ROUTE_POINTS = 180;
const routeCache = new Map<string, { requestedAt: number; key: string; metrics: RoadRouteMetrics | null }>();

function validPoint(point: Point | null | undefined): point is Point {
  return Boolean(
    point
    && Number.isFinite(point.latitude)
    && Number.isFinite(point.longitude)
    && point.latitude >= -90 && point.latitude <= 90
    && point.longitude >= -180 && point.longitude <= 180,
  );
}

function pointFrom(value: any): Point | null {
  const latitude = Number(value?.latitude ?? value?.lat);
  const longitude = Number(value?.longitude ?? value?.lng);
  const point = { latitude, longitude };
  return validPoint(point) ? point : null;
}

function routeTarget(ride: Record<string, any>): Point | null {
  return String(ride.status) === 'in_progress'
    ? pointFrom(ride.destination)
    : pointFrom(ride.pickup);
}

function routeKey(from: Point, to: Point) {
  return [from.latitude, from.longitude, to.latitude, to.longitude]
    .map((value) => Number(value).toFixed(5))
    .join(':');
}

function boundedRoutePoints(points: RoutePoint[]): RoutePoint[] {
  if (points.length <= MAX_ROUTE_POINTS) return points;
  const step = (points.length - 1) / (MAX_ROUTE_POINTS - 1);
  return Array.from({ length: MAX_ROUTE_POINTS }, (_, index) => points[Math.round(index * step)]);
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

/** Prefers commercial live-traffic routing, while preserving a road-route fallback during provider outages. */
export async function fetchRoadRoute(from: Point, to: Point): Promise<RoadRouteMetrics | null> {
  return await fetchGoogleTrafficRoute(from, to) || await fetchOsrmRoadRoute(from, to);
}

async function cachedRoadRoute(rideId: string, from: Point, to: Point): Promise<RoadRouteMetrics | null> {
  const now = Date.now();
  const key = routeKey(from, to);
  const previous = routeCache.get(rideId);
  if (previous && previous.key === key && now - previous.requestedAt < ROUTE_REFRESH_MS) return previous.metrics;

  // Mark the request before awaiting it so duplicate REST/tRPC location paths
  // cannot fan out multiple routing calls for the same ride in one instance.
  routeCache.set(rideId, { requestedAt: now, key, metrics: previous?.metrics || null });
  const metrics = await fetchRoadRoute(from, to);
  routeCache.set(rideId, { requestedAt: now, key, metrics: metrics || previous?.metrics || null });
  return metrics || previous?.metrics || null;
}

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

  let updated = 0;
  await Promise.all(rides.map(async (ride) => {
    const rideId = String(ride.id || '');
    const target = routeTarget(ride);
    if (!rideId || !target) return;
    const metrics = await cachedRoadRoute(rideId, driverLocation, target);
    if (!metrics) return;

    const phase = String(ride.status) === 'in_progress' ? 'destination' : 'pickup';
    await adminFirestore.update(ADMIN_COLLECTIONS.RIDES, rideId, {
      live_route_metrics: {
        distance_km: metrics.distanceKm,
        duration_minutes: metrics.durationMinutes,
        phase,
        points: metrics.points,
        source: metrics.source,
        traffic: metrics.traffic || null,
        updated_at: new Date().toISOString(),
      },
      route_distance_source: metrics.source === 'google_routes_traffic'
        ? 'server_google_routes_traffic'
        : 'server_osrm_road_route_fallback',
    });
    updated += 1;
  }));

  return { attempted: rides.length, updated };
}
