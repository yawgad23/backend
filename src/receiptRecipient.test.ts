import { describe, expect, it } from 'vitest';
import { receiptEmail } from './driverRouters';

describe('receiptEmail', () => {
  it('accepts a real Rider email address', () => {
    expect(receiptEmail(' Rider@Example.com ')).toBe('rider@example.com');
  });

  it('rejects malformed recipient values', () => {
    expect(receiptEmail('not-an-email')).toBe('');
    expect(receiptEmail(null)).toBe('');
  });

  it('rejects internal phone-auth placeholder addresses', () => {
    expect(receiptEmail('phone-233123456789@hy3n.local')).toBe('');
  });
});
