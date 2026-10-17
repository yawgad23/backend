import { describe, expect, it } from 'vitest';
import {
  activeLegacyLocationPresencePatch,
  availabilityHeartbeatLocation,
  canPublishActiveLegacyRideLocation,
  driverLocationInput,
  driverLocationTimestamps,
} from './driverLocation';
import { isOnlineWithFreshLocation } from './driverPresence';

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

  it('allows location compatibility only for the authenticated Driver already assigned to an active legacy ride', () => {
    const ride = { driver_id: 'firebase-driver-uid', status: 'in_progress' };

    expect(canPublishActiveLegacyRideLocation(ride, 'firebase-driver-uid')).toBe(true);
    expect(canPublishActiveLegacyRideLocation(ride, 'another-driver-uid')).toBe(false);
  });

  it.each(['searching', 'completed', 'cancelled', 'expired'])('does not turn a %s ride into location authorization', (status) => {
    expect(canPublishActiveLegacyRideLocation({ driver_id: 'firebase-driver-uid', status }, 'firebase-driver-uid')).toBe(false);
  });

  it('does not treat a client-supplied owner field as an assigned active Driver', () => {
    expect(canPublishActiveLegacyRideLocation({ driverId: 'firebase-driver-uid', status: 'in_progress' }, 'firebase-driver-uid')).toBe(false);
  });

  it('keeps compatibility presence non-dispatchable even while its location is fresh', () => {
    const receivedAt = '2026-10-17T20:26:00.000Z';
    const presence = activeLegacyLocationPresencePatch('firebase-driver-uid', {
      latitude: 5.6037,
      longitude: -0.187,
      recorded_at: receivedAt,
      source_recorded_at: receivedAt,
    }, receivedAt);

    expect(presence).toMatchObject({
      availability_status: 'busy',
      is_online: false,
      is_available: false,
      approved: false,
      is_approved: false,
    });
    expect(isOnlineWithFreshLocation(presence, new Date(receivedAt).getTime())).toBe(false);
  });
});
