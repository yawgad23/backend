import { describe, expect, it } from 'vitest';
import {
  getCappedCompatibilityDistanceKm,
  getMeteredFareBreakdown,
  getMeteredTripFare,
  getTripDurationMinutes,
} from './fareAuthority';
import { advanceTripMeter, initializeTripMeter } from './tripMeter';

describe('metered trip fares', () => {
  it('does not reuse a booked route estimate when a trip has no travel', () => {
    const fare = getMeteredTripFare({
      category: 'standard',
      distanceKm: 0,
      durationMinutes: 0,
      waitingFee: 0,
    });

    // The standard minimum plus booking fee is allowed, but a GH₵69 booking
    // quote can never become the completed fare when no distance was recorded.
    expect(fare).toBe(19);
    expect(fare).toBeLessThan(69);
  });

  it('includes only post-start distance, elapsed time, and recorded waiting fee', () => {
    const breakdown = getMeteredFareBreakdown({
      category: 'standard',
      distanceKm: 10,
      durationMinutes: 20,
      waitingFee: 2.2,
    });

    expect(breakdown.distanceFare).toBeCloseTo(36.5, 5);
    expect(breakdown.timeFare).toBeCloseTo(8.6, 5);
    expect(breakdown.waitingFee).toBe(2.2);
    expect(breakdown.total).toBe(60);
  });

  it('uses server time only after the recorded Start Trip timestamp', () => {
    expect(getTripDurationMinutes('2026-09-24T15:00:00.000Z', Date.parse('2026-09-24T15:15:00.000Z'))).toBe(15);
    expect(getTripDurationMinutes('not-a-date', Date.now())).toBe(0);
  });

  it('caps compatibility distance without ever turning zero into the booking estimate', () => {
    expect(getCappedCompatibilityDistanceKm(0, 10)).toBe(0);
    expect(getCappedCompatibilityDistanceKm(100, 10)).toBe(14);
    expect(getCappedCompatibilityDistanceKm(undefined, 10)).toBeNull();
  });
});

describe('server trip meter', () => {
  it('counts plausible movement but rejects GPS drift and teleport jumps', () => {
    const startedAt = '2026-09-24T15:00:00.000Z';
    let meter = initializeTripMeter(startedAt, { latitude: 5.6037, longitude: -0.187 });

    const noise = advanceTripMeter(meter, { latitude: 5.60371, longitude: -0.187 }, '2026-09-24T15:00:05.000Z');
    meter = noise.meter;
    expect(noise.accepted).toBe(false);
    expect(noise.ignoredReason).toBe('noise');
    expect(meter.distance_km).toBe(0);

    const movement = advanceTripMeter(meter, { latitude: 5.6042, longitude: -0.187 }, '2026-09-24T15:00:30.000Z');
    meter = movement.meter;
    expect(movement.accepted).toBe(true);
    expect(meter.distance_km).toBeGreaterThan(0.025);

    const jump = advanceTripMeter(meter, { latitude: 6.6037, longitude: -0.187 }, '2026-09-24T15:00:35.000Z');
    expect(jump.accepted).toBe(false);
    expect(jump.ignoredReason).toBe('jump');
    expect(jump.meter.distance_km).toBe(meter.distance_km);
  });
});
