import { describe, expect, it } from 'vitest';
import { isExpoPushToken } from '../src/pushNotifications';

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
});
