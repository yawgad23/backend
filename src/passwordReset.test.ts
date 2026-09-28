import { describe, expect, it } from 'vitest';
import {
  allowsPasswordResetRequest,
  normalizeResetEmail,
  passwordResetRateKey,
} from './passwordReset';

describe('password reset request protections', () => {
  const now = Date.UTC(2026, 8, 28, 12, 0, 0);

  it('normalizes valid email input and rejects malformed values', () => {
    expect(normalizeResetEmail('  Rider@Example.COM ')).toBe('rider@example.com');
    expect(normalizeResetEmail('not-an-email')).toBeNull();
    expect(normalizeResetEmail('')).toBeNull();
  });

  it('uses one-way rate-limit keys without retaining the source email or IP', () => {
    const email = 'rider@example.com';
    const key = passwordResetRateKey('email', email);
    expect(key).toMatch(/^email_[A-Za-z0-9_-]{43}$/);
    expect(key).not.toContain(email);
  });

  it('allows a bounded number of reset attempts and blocks the next request', () => {
    const attempts = [now - 50_000, now - 40_000, now - 30_000];
    expect(allowsPasswordResetRequest(attempts, [], now)).toBe(false);
  });

  it('enforces a cooldown even before the hourly account cap is reached', () => {
    expect(allowsPasswordResetRequest([now - 20_000], [], now)).toBe(false);
    expect(allowsPasswordResetRequest([now - 70_000], [], now)).toBe(true);
  });

  it('blocks IP bursts independently of the submitted email', () => {
    const ipAttempts = Array.from({ length: 10 }, (_, index) => now - (index + 1) * 1_000);
    expect(allowsPasswordResetRequest([], ipAttempts, now)).toBe(false);
  });
});
