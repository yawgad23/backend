import { describe, expect, it } from 'vitest';
import { availabilityHeartbeatLocation, driverLocationInput, driverLocationTimestamps } from './driverLocation';

describe('Driver location ingress', () => {
  const coordinateSample = {
    latitude: 5.6037,
    longitude: -0.187,
    recordedAt: '2026-10-03T01:21:00.000Z',
  };

  it('accepts Core Location’s -1 unknown heading while a Driver goes online', () => {
    const result = driverLocationInput.safeParse({ ...coordinateSample, heading: -1, speedKmh: 0 });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.heading).toBeNull();
  });

  it('retains a valid compass heading and rejects a genuine out-of-range value', () => {
    expect(driverLocationInput.safeParse({ ...coordinateSample, heading: 275, speedKmh: 12.5 }).success).toBe(true);
    expect(driverLocationInput.safeParse({ ...coordinateSample, heading: -2 }).success).toBe(false);
  });

  it('uses the authenticated server receipt time for live availability while retaining the GPS sample time for ordering', () => {
    expect(driverLocationTimestamps('2026-10-03T07:49:45.174Z', '2026-10-03T07:52:09.800Z')).toEqual({
      sourceRecordedAt: '2026-10-03T07:49:45.174Z',
      receivedAt: '2026-10-03T07:52:09.800Z',
    });
  });

  it('refreshes a verified Driver heartbeat without replacing a newer stored coordinate', () => {
    expect(availabilityHeartbeatLocation({ current_location: {
      latitude: 5.6037,
      longitude: -0.187,
      source_recorded_at: '2026-10-03T07:49:45.174Z',
      recorded_at: '2026-10-03T07:49:45.174Z',
    } }, '2026-10-03T07:54:00.000Z')).toEqual({
      latitude: 5.6037,
      longitude: -0.187,
      source_recorded_at: '2026-10-03T07:49:45.174Z',
      recorded_at: '2026-10-03T07:54:00.000Z',
    });
  });
});
