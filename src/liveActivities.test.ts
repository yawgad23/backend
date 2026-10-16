import { describe, expect, it } from 'vitest';
import {
  HY3N_LIVE_ACTIVITY_IMAGE_NAME,
  liveActivityPresentation,
  liveActivityTripProgress,
} from './liveActivities';

describe('Rider Live Activity trip progress', () => {
  it('uses the owned HY3N vehicle asset for native Island updates', () => {
    expect(HY3N_LIVE_ACTIVITY_IMAGE_NAME).toBe('hy3n_trip_car');
  });

  it('advances only as the server road distance to destination shrinks', () => {
    expect(liveActivityTripProgress({ status: 'in_progress', quotedDistanceKm: 10, remainingDistanceKm: 10 })).toBe(0);
    expect(liveActivityTripProgress({ status: 'in_progress', quotedDistanceKm: 10, remainingDistanceKm: 6 })).toBeCloseTo(0.4, 5);
    expect(liveActivityTripProgress({ status: 'in_progress', quotedDistanceKm: 10, remainingDistanceKm: 2, previousProgress: 0.4 })).toBeCloseTo(0.8, 5);
  });

  it('cannot look complete before the server confirms terminal trip state', () => {
    expect(liveActivityTripProgress({ status: 'in_progress', quotedDistanceKm: 10, remainingDistanceKm: 0, previousProgress: 0.8 })).toBe(0.98);
    expect(liveActivityTripProgress({ status: 'in_progress', quotedDistanceKm: 10, remainingDistanceKm: 8, previousProgress: 0.8 })).toBe(0.8);
    expect(liveActivityTripProgress({ status: 'driver_arrived', quotedDistanceKm: 10, remainingDistanceKm: 0.5, previousProgress: 0.8 })).toBe(0);
  });

  it('does not let the display-only progress mutate terminal Live Activity handling', async () => {
    const start = Date.now();
    const presentation = await liveActivityPresentation({
      id: 'ride-complete-1',
      status: 'completed',
      destination: { name: 'Airport', lat: 5.605, lng: -0.174 },
      driver_location: { latitude: 5.603, longitude: -0.18 },
    });

    expect(presentation).toEqual({
      event: 'end',
      title: 'Trip complete',
      subtitle: 'Thank you for riding with HY3N',
      arrivalAt: null,
      progress: 1,
    });
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('ends a cancelled ride with a terminal cancellation state', async () => {
    await expect(liveActivityPresentation({ id: 'ride-cancel-1', status: 'cancelled' })).resolves.toMatchObject({
      event: 'end',
      title: 'Ride cancelled',
      arrivalAt: null,
      progress: 1,
    });
  });
});
