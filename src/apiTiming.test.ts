import { describe, expect, it } from 'vitest';
import { apiTimingRecord, apiTimingRoute } from './apiTiming';

describe('privacy-safe API timing telemetry', () => {
  it('keeps the route template and removes query parameters and opaque IDs', () => {
    expect(apiTimingRoute('/api/rides/3rTszVd5ms3GQHRn42L9/status?token=secret&driver=private'))
      .toBe('/api/rides/:id/status');
  });

  it('records only compact operational fields', () => {
    expect(apiTimingRecord('post', '/api/trpc/driverTrips.availableOffers?input=private', 201, 1048.4))
      .toEqual({
        event: 'api_timing',
        method: 'POST',
        route: '/api/trpc/driverTrips.availableOffers',
        status: 201,
        duration_ms: 1048,
        slow: true,
      });
  });
});
