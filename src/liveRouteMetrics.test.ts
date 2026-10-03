import { describe, expect, it } from 'vitest';
import {
  bookingRouteCacheKey,
  decodeGooglePolyline,
  firestoreSafeLiveRoutePoints,
  parseGoogleTrafficRoute,
  parseOsrmRoute,
  preferGoogleRouteWithFastFallback,
  routeTargetKey,
  ROUTE_REFRESH_MS,
  serverCoordinateRouteEstimate,
  shouldReuseCachedRoute,
} from './liveRouteMetrics';

describe('server road route metrics', () => {
  it('normalizes OSRM distance, duration, and geometry to app coordinates', () => {
    const result = parseOsrmRoute({
      routes: [{
        distance: 2480.8,
        duration: 731.4,
        geometry: { coordinates: [[-0.187, 5.6037], [-0.19, 5.61]] },
      }],
    });

    expect(result).toEqual({
      distanceKm: 2.481,
      durationMinutes: 12.2,
      points: [[5.6037, -0.187], [5.61, -0.19]],
      source: 'osrm',
    });
  });

  it('decodes Google encoded polylines to app coordinates', () => {
    expect(decodeGooglePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@')).toEqual([
      [38.5, -120.2],
      [40.7, -120.95],
      [43.252, -126.453],
    ]);
  });

  it('normalizes Google traffic-aware route duration, geometry, and speed intervals', () => {
    const result = parseGoogleTrafficRoute({
      routes: [{
        distanceMeters: 2480.8,
        duration: '780s',
        staticDuration: '660s',
        polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' },
        travelAdvisory: {
          speedReadingIntervals: [
            { endPolylinePointIndex: 1, speed: 'NORMAL' },
            { startPolylinePointIndex: 1, endPolylinePointIndex: 3, speed: 'SLOW' },
          ],
        },
      }],
    });

    expect(result).toEqual({
      distanceKm: 2.481,
      durationMinutes: 13,
      points: [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]],
      source: 'google_routes_traffic',
      traffic: {
        staticDurationMinutes: 11,
        delayMinutes: 2,
        speedIntervals: [
          { startPointIndex: 0, endPointIndex: 1, speed: 'NORMAL' },
          { startPointIndex: 1, endPointIndex: 3, speed: 'SLOW' },
        ],
      },
    });
  });

  it('rejects incomplete or invalid route responses', () => {
    expect(parseOsrmRoute(null)).toBeNull();
    expect(parseOsrmRoute({ routes: [{ distance: -1, duration: 60 }] })).toBeNull();
    expect(parseGoogleTrafficRoute({ routes: [{ distanceMeters: 500 }] })).toBeNull();
    expect(parseOsrmRoute({ routes: [] })).toBeNull();
  });

  it('keeps a quote server-owned when every external route provider is unavailable', () => {
    const result = serverCoordinateRouteEstimate(
      { latitude: 5.6037, longitude: -0.187 },
      [{ latitude: 5.6501, longitude: -0.1952 }],
    );

    expect(result?.source).toBe('server_coordinate_estimate');
    expect(result?.points).toEqual([]);
    expect(result?.distanceKm).toBeGreaterThan(0);
    expect(result?.durationMinutes).toBeGreaterThan(0);
  });

  it('uses a quick Google traffic route before its booking fallback', async () => {
    const google = { distanceKm: 1, durationMinutes: 4, points: [[5.6, -0.18], [5.61, -0.17]] as [number, number][], source: 'google_routes_traffic' as const };
    const osrm = { distanceKm: 1.1, durationMinutes: 5, points: [[5.6, -0.18], [5.61, -0.17]] as [number, number][], source: 'osrm' as const };

    await expect(preferGoogleRouteWithFastFallback(Promise.resolve(google), Promise.resolve(osrm), 10)).resolves.toEqual(google);
  });

  it('uses a ready road fallback instead of holding a booking quote for a slow traffic response', async () => {
    const osrm = { distanceKm: 1.1, durationMinutes: 5, points: [[5.6, -0.18], [5.61, -0.17]] as [number, number][], source: 'osrm' as const };
    const slowGoogle = new Promise<null>(() => {});

    await expect(preferGoogleRouteWithFastFallback(slowGoogle, Promise.resolve(osrm), 0)).resolves.toEqual(osrm);
  });

  it('uses a five-decimal booking key so selected and background quotes share the same route computation', () => {
    expect(bookingRouteCacheKey(
      { latitude: 5.603701, longitude: -0.187001 },
      [{ latitude: 5.650101, longitude: -0.195201 }],
    )).toBe('5.60370,-0.18700~5.65010,-0.19520');
  });

  it('encodes active-trip geometry without Firestore-invalid nested arrays', () => {
    expect(firestoreSafeLiveRoutePoints([[5.6037, -0.187], [5.61, -0.19]])).toEqual([
      { lat: 5.6037, lng: -0.187 },
      { lat: 5.61, lng: -0.19 },
    ]);
  });

  it('refreshes immediately when Start Trip changes the route target from pickup to destination', () => {
    const pickupKey = routeTargetKey({ latitude: 5.61, longitude: -0.19 });
    const destinationKey = routeTargetKey({ latitude: 5.57, longitude: -0.17 });
    const cachedPickupRoute = { requestedAt: 1_000, targetKey: pickupKey };

    expect(shouldReuseCachedRoute(cachedPickupRoute, pickupKey, 1_000 + ROUTE_REFRESH_MS - 1)).toBe(true);
    expect(shouldReuseCachedRoute(cachedPickupRoute, pickupKey, 1_000 + ROUTE_REFRESH_MS)).toBe(false);
    expect(shouldReuseCachedRoute(cachedPickupRoute, destinationKey, 1_001)).toBe(false);
  });
});
