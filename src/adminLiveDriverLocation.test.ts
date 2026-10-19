import { describe, expect, it } from 'vitest';
import {
  adminDriverLocationProjection,
  freshAdminDriverLocations,
} from './adminLiveDriverLocation';
import { DRIVER_LOCATION_FRESHNESS_MS } from './driverPresence';

const now = Date.parse('2026-10-19T18:00:00.000Z');

function presence(overrides: Record<string, unknown> = {}) {
  return {
    current_location: {
      latitude: 5.6037,
      longitude: -0.187,
      recorded_at: new Date(now - 60_000).toISOString(),
      source_recorded_at: '2000-01-01T00:00:00.000Z',
      heading: 90,
      speedKmh: 31,
    },
    license_plate: 'PRIVATE-PLATE',
    vehicle_model: 'PRIVATE-MODEL',
    ...overrides,
  };
}

describe('protected Admin Driver location projection', () => {
  it('returns only a fresh server-receipt point without presence or device metadata', () => {
    expect(adminDriverLocationProjection(presence(), now)).toEqual({
      latitude: 5.6037,
      longitude: -0.187,
      updated_at: new Date(now - 60_000).toISOString(),
      is_fresh: true,
    });
  });

  it('uses the authenticated receipt timestamp rather than the device ordering timestamp', () => {
    expect(adminDriverLocationProjection(presence({
      current_location: {
        latitude: 5.6037,
        longitude: -0.187,
        recorded_at: new Date(now - 10_000).toISOString(),
        source_recorded_at: '2000-01-01T00:00:00.000Z',
      },
    }), now)?.updated_at).toBe(new Date(now - 10_000).toISOString());
  });

  it('rejects stale, future, malformed, and out-of-range positions rather than drawing a misleading marker', () => {
    expect(adminDriverLocationProjection(presence({
      current_location: { latitude: 5.6, longitude: -0.1, recorded_at: new Date(now - DRIVER_LOCATION_FRESHNESS_MS - 1).toISOString() },
    }), now)).toBeNull();
    expect(adminDriverLocationProjection(presence({
      current_location: { latitude: 5.6, longitude: -0.1, recorded_at: new Date(now + 60_001).toISOString() },
    }), now)).toBeNull();
    expect(adminDriverLocationProjection(presence({
      current_location: { latitude: 91, longitude: -0.1, recorded_at: new Date(now).toISOString() },
    }), now)).toBeNull();
    expect(adminDriverLocationProjection(presence({
      current_location: { latitude: 5.6, longitude: Number.NaN, recorded_at: new Date(now).toISOString() },
    }), now)).toBeNull();
    expect(adminDriverLocationProjection(presence({
      current_location: { latitude: 5.6, longitude: -0.1, recorded_at: 'not-a-timestamp' },
    }), now)).toBeNull();
  });

  it('reads a valid assigned Driver presence once and skips malformed document IDs', async () => {
    const reads: string[] = [];
    const locations = await freshAdminDriverLocations(
      ['driver-1', 'driver-1', '../not-a-driver', '', null],
      async (driverId) => {
        reads.push(driverId);
        return presence();
      },
      now,
    );

    expect(reads).toEqual(['driver-1']);
    expect(locations.get('driver-1')).toMatchObject({ latitude: 5.6037, longitude: -0.187, is_fresh: true });
    expect(locations.has('../not-a-driver')).toBe(false);
  });
});
