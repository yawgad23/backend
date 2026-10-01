import { describe, expect, it } from 'vitest';
import { parseOsrmRoute } from './liveRouteMetrics';

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

  it('rejects incomplete or invalid route responses', () => {
    expect(parseOsrmRoute(null)).toBeNull();
    expect(parseOsrmRoute({ routes: [{ distance: -1, duration: 60 }] })).toBeNull();
    expect(parseOsrmRoute({ routes: [] })).toBeNull();
  });
});
