import { describe, expect, it } from 'vitest';
import {
  DRIVER_LOCATION_FRESHNESS_MS,
  hasFreshDriverLocation,
  isOnlineWithFreshLocation,
  mapSafeDriverPresenceMetadata,
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

  it('publishes only the approval and category fields required for Rider visibility', () => {
    expect(mapSafeDriverPresenceMetadata({
      approval_status: 'approved',
      account_status: 'active',
      ride_categories: ['standard'],
      email: 'not-for-presence@example.invalid',
      momo_number: 'not-for-presence',
    })).toEqual({
      approval_status: 'approved',
      approved: true,
      is_approved: true,
      ride_categories: ['standard'],
    });
  });

  it('does not mark an inactive or pending Driver approved on the Rider map', () => {
    expect(mapSafeDriverPresenceMetadata({ approval_status: 'pending', ride_categories: ['standard'] }).approved).toBe(false);
    expect(mapSafeDriverPresenceMetadata({ approval_status: 'approved', account_status: 'inactive', ride_categories: ['standard'] }).approved).toBe(false);
  });
});
