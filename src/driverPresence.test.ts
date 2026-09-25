import { describe, expect, it } from 'vitest';
import {
  DRIVER_LOCATION_FRESHNESS_MS,
  hasFreshDriverLocation,
  isOnlineWithFreshLocation,
  profilePresencePatch,
} from './driverPresence';

const now = Date.parse('2026-09-25T00:00:00.000Z');

describe('Driver presence freshness', () => {
  it('accepts an online Driver with a recent GPS heartbeat', () => {
    const profile = {
      is_online: true,
      availability_status: 'online',
      current_location: { recorded_at: new Date(now - 30_000).toISOString() },
    };
    expect(hasFreshDriverLocation(profile, now)).toBe(true);
    expect(isOnlineWithFreshLocation(profile, now)).toBe(true);
  });

  it('hides a Driver after the GPS heartbeat becomes stale', () => {
    const profile = {
      is_online: true,
      availability_status: 'online',
      last_location_update: new Date(now - DRIVER_LOCATION_FRESHNESS_MS - 1).toISOString(),
    };
    expect(hasFreshDriverLocation(profile, now)).toBe(false);
    expect(isOnlineWithFreshLocation(profile, now)).toBe(false);
  });

  it('never treats a timestamp-less online profile as live', () => {
    expect(isOnlineWithFreshLocation({ is_online: true, availability_status: 'online' }, now)).toBe(false);
  });

  it('creates one consistent offline presence patch', () => {
    expect(profilePresencePatch('offline')).toMatchObject({
      availability_status: 'offline',
      is_online: false,
      is_available: false,
    });
  });
});
