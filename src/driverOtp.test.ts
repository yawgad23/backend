import { describe, expect, it } from 'vitest';
import { normalizeGhanaPhone } from './driverOtp';

describe('Hubtel Driver OTP phone normalization', () => {
  it('converts local and international Ghana formats to Hubtel SMS E.164 form', () => {
    expect(normalizeGhanaPhone('055 727 8990')).toBe('+233557278990');
    expect(normalizeGhanaPhone('233557278990')).toBe('+233557278990');
    expect(normalizeGhanaPhone('+233557278990')).toBe('+233557278990');
  });

  it('rejects malformed or non-Ghana mobile numbers', () => {
    expect(normalizeGhanaPhone('055727899')).toBeNull();
    expect(normalizeGhanaPhone('+15572789900')).toBeNull();
    expect(normalizeGhanaPhone('')).toBeNull();
  });
});
