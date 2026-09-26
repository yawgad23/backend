import { describe, expect, it } from 'vitest';
import { normalizeGhanaPhone, phoneLookupValues, profileMatchesVerifiedPhone } from './driverPhoneLogin';

describe('Driver phone login identity mapping', () => {
  it.each([
    ['024 122 0725', '+233241220725'],
    ['233241220725', '+233241220725'],
    ['00233241220725', '+233241220725'],
  ])('normalizes %s to a Ghana E.164 number', (input, expected) => {
    expect(normalizeGhanaPhone(input)).toBe(expected);
  });

  it('looks up legacy profile phone representations without accepting another number', () => {
    expect(phoneLookupValues('+233241220725')).toEqual(expect.arrayContaining(['+233241220725', '0241220725', '233241220725', '241220725']));
    expect(profileMatchesVerifiedPhone({ phone: '024 122 0725' }, '+233241220725')).toBe(true);
    expect(profileMatchesVerifiedPhone({ phone_number: '233241220725' }, '+233241220725')).toBe(true);
    expect(profileMatchesVerifiedPhone({ mobile_number: '024 122 0726' }, '+233241220725')).toBe(false);
  });

  it('rejects incomplete or non-Ghana numbers', () => {
    expect(normalizeGhanaPhone('024 122 072')).toBeNull();
    expect(normalizeGhanaPhone('+234241220725')).toBeNull();
  });
});
