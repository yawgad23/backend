import { describe, expect, it } from 'vitest';
import { driverLocationInput } from './driverLocation';

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
});
