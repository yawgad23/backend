import { describe, expect, it } from 'vitest';
import { selectVerifiedRiderAccountRecovery } from './riderAccountRecovery';

const legacyRider = {
  id: 'legacy-rider-document',
  user_id: 'legacy-rider-owner',
  full_name: 'Yaw Gad',
  email: 'rider@example.com',
  phone: '0541220725',
  total_rides: 4,
  updated_date: '2026-10-16T10:00:00.000Z',
};

function select(overrides: Partial<Parameters<typeof selectVerifiedRiderAccountRecovery>[0]> = {}) {
  return selectVerifiedRiderAccountRecovery({
    currentUid: 'signed-in-firebase-owner',
    sessionEmail: 'RIDER@example.com',
    sessionPhone: null,
    requestedEmail: 'rider@example.com',
    requestedPhone: '+233541220725',
    riderProfiles: [legacyRider],
    ...overrides,
  });
}

describe('verified Rider account recovery', () => {
  it('recovers the one active legacy Rider with the same verified email and Ghana phone', () => {
    expect(select()).toMatchObject({
      legacyOwnerUid: 'legacy-rider-owner',
      profile: { id: 'legacy-rider-document', full_name: 'Yaw Gad', total_rides: 4 },
    });
  });

  it('recovers the same account when the Rider signs in with the verified phone', () => {
    expect(select({ sessionEmail: null, sessionPhone: '+233541220725' })).toMatchObject({
      legacyOwnerUid: 'legacy-rider-owner',
    });
  });

  it('does not transfer a profile without a token-derived matching contact', () => {
    expect(select({ sessionEmail: null, sessionPhone: null })).toBeNull();
  });

  it('does not transfer a profile if the entered phone does not match the legacy profile', () => {
    expect(select({ requestedPhone: '+233241234567' })).toBeNull();
  });

  it('does not transfer a profile for a phone session whose verified number is different', () => {
    expect(select({ sessionEmail: null, sessionPhone: '+233241234567' })).toBeNull();
  });

  it('uses only Rider profiles for recovery selection', () => {
    // A Driver profile intentionally is not an input to the Rider selector:
    // Rider and Driver may share the same email and phone.
    expect(select()).toMatchObject({ legacyOwnerUid: 'legacy-rider-owner' });
  });

  it('keeps recovery blocked when a different Rider owns either matching contact', () => {
    expect(select({
      riderProfiles: [
        legacyRider,
        {
          id: 'different-rider-document',
          user_id: 'different-rider-owner',
          email: 'other@example.com',
          phone: '0541220725',
        },
      ],
    })).toBeNull();
  });

  it('does not reactivate an inactive legacy account automatically', () => {
    expect(select({ riderProfiles: [{ ...legacyRider, account_status: 'inactive' }] })).toBeNull();
  });
});
