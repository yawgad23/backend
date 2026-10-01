import { ADMIN_COLLECTIONS, adminFirestore } from './firebaseAdmin';

type Point = { latitude: number; longitude: number };
type RoutePoint = [number, number];

export type RoadRouteMetrics = {
  distanceKm: number;
  durationMinutes: number;
  points: RoutePoint[];
  source: 'osrm';
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

/** Converts OSRM GeoJSON coordinates ([lng, lat]) to the app's [lat, lng]. */
export function parseOsrmRoute(body: any): RoadRouteMetrics | null {
  const route = body?.routes?.[0];
  const distanceKm = Number(route?.distance) / 1000;
  const durationMinutes = Number(route?.duration) / 60;
  if (!Number.isFinite(distanceKm) || distanceKm < 0 || !Number.isFinite(durationMinutes) || durationMinutes < 0) return null;

  const coordinates = Array.isArray(route?.geometry?.coordinates) ? route.geometry.coordinates : [];
  const points = coordinates
    .filter((coordinate: any) => Array.isArray(coordinate) && coordinate.length >= 2)
    .map((coordinate: any) => [Number(coordinate[1]), Number(coordinate[0])] as RoutePoint)
    .filter(([latitude, longitude]: RoutePoint) => Number.isFinite(latitude) && Number.isFinite(longitude));

  return {
    distanceKm: Number(distanceKm.toFixed(3)),
    durationMinutes: Number(durationMinutes.toFixed(1)),
    points: boundedRoutePoints(points),
    source: 'osrm',
  };
}

export async function fetchRoadRoute(from: Point, to: Point): Promise<RoadRouteMetrics | null> {
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${from.longitude},${from.latitude};${to.longitude},${to.latitude}?overview=full&geometries=geojson&steps=false`;
    const response = await fetch(url, { signal: AbortSignal.timeout(4_000) });
    if (!response.ok) return null;
    return parseOsrmRoute(await response.json().catch(() => null));
  } catch {
    return null;
  }
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
 * Refreshes road-matched metrics for every active ride assigned to a Driver.
 * Only the backend writes these values; mobile clients never supply distance,
 * duration, or route geometry as authority.
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
        updated_at: new Date().toISOString(),
      },
      route_distance_source: 'server_osrm_road_route',
    });
    updated += 1;
  }));

  return { attempted: rides.length, updated };
}
