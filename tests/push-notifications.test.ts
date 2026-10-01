import { describe, expect, it } from 'vitest';
import { buildRideStatusPush, isExpoPushToken } from '../src/pushNotifications';

describe('Expo push token validation', () => {
  it('accepts Expo and Exponent project tokens', () => {
    expect(isExpoPushToken('ExpoPushToken[abcDEF1234567890]')).toBe(true);
    expect(isExpoPushToken('ExponentPushToken[abcDEF1234567890]')).toBe(true);
  });

  it('rejects malformed and blank values', () => {
    expect(isExpoPushToken('')).toBe(false);
    expect(isExpoPushToken('not-a-push-token')).toBe(false);
    expect(isExpoPushToken('ExpoPushToken[]')).toBe(false);
  });

  it('builds privacy-safe messages for Rider-visible status transitions only', () => {
    expect(buildRideStatusPush({ status: 'driver_arriving', driver_name: 'Kofi' })).toEqual({
      status: 'driver_arriving',
      title: 'Driver is on the way',
      body: 'Kofi is heading to your pickup.',
    });
    expect(buildRideStatusPush({ status: 'completed' })).toMatchObject({
      status: 'completed',
      title: 'Trip complete',
    });
    expect(buildRideStatusPush({ status: 'searching' })).toBeNull();
  });
});
