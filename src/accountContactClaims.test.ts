import { describe, expect, it } from 'vitest';
import {
  contactClaimDocumentId,
  legacyContactOwners,
  normalizeAccountEmail,
  normalizeAccountPhone,
  normalizedContactEntries,
} from './accountContactClaims';

describe('account contact claims', () => {
  it('normalizes Ghana phone representations to one contact identity', () => {
    expect(normalizeAccountPhone('024 122 0725')).toBe('+233241220725');
    expect(normalizeAccountPhone('233241220725')).toBe('+233241220725');
    expect(normalizeAccountPhone('+233 24 122 0725')).toBe('+233241220725');
    expect(normalizeAccountPhone('020123')).toBeNull();
  });

  it('normalizes email casing and creates opaque deterministic claim IDs', () => {
    const email = normalizeAccountEmail('  Rider@Example.com ');
    expect(email).toBe('rider@example.com');
    expect(contactClaimDocumentId('email', email!)).toMatch(/^[a-f0-9]{64}$/);
    expect(contactClaimDocumentId('email', email!)).not.toBe(contactClaimDocumentId('phone', email!));
  });

  it('indexes duplicate legacy contacts across Rider and Driver profiles', () => {
    const owners = legacyContactOwners([
      { id: 'rider-uid', user_id: 'rider-uid', email: 'Rider@example.com', phone: '0241220725' },
      { id: 'driver-uid', user_id: 'driver-uid', email: 'driver@example.com', phone_number: '+233241220725' },
    ]);

    expect([...owners.get('email:rider@example.com') || []]).toEqual(['rider-uid']);
    expect(new Set(owners.get('phone:+233241220725'))).toEqual(new Set(['rider-uid', 'driver-uid']));
  });

  it('does not create a claim entry for an empty or invalid contact', () => {
    expect(normalizedContactEntries({ email: 'not an email', phone: '0123' })).toEqual([]);
  });
});
