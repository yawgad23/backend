import { describe, expect, it } from 'vitest';
import { fcmTokensFromRiderProfiles, parseAdminNotificationInput } from './adminNotifications';

describe('admin notification inputs', () => {
  it('accepts bounded notification content and its declared type', () => {
    expect(parseAdminNotificationInput({
      title: 'HY3N update',
      body: 'Your Driver is arriving soon.',
      type: 'general',
    })).toEqual({
      title: 'HY3N update',
      body: 'Your Driver is arriving soon.',
      type: 'general',
    });
  });

  it('rejects empty or overlong broadcast content', () => {
    expect(() => parseAdminNotificationInput({ title: '', body: 'Message', type: 'general' })).toThrow();
    expect(() => parseAdminNotificationInput({ title: 'Title', body: 'x'.repeat(201), type: 'general' })).toThrow();
  });

  it('deduplicates only plausible device tokens before dispatch', () => {
    const token = 'ExponentPushToken[1234567890abcdef1234567890]';
    expect(fcmTokensFromRiderProfiles([
      { fcm_token: token },
      { fcm_token: token },
      { fcm_token: 'too-short' },
      {},
    ])).toEqual([token]);
  });
});
