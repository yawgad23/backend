import { describe, expect, it } from 'vitest';
import {
  driverIdentityRecoveryPatch,
  legacyRiderContactMatches,
  newest,
  riderIdentityRecoveryPatch,
  sortProfilesNewestFirst,
} from './adminAccountRoutes';

describe('admin account profile ordering', () => {
  it('keeps legacy Rider profiles with no created_date visible', () => {
    const legacyRider = {
      id: 'legacy-rider',
      user_id: 'rider-legacy',
      full_name: 'Legacy Rider',
      updated_date: '2026-10-14T01:00:00.000Z',
    };
    const currentRider = {
      id: 'current-rider',
      user_id: 'rider-current',
      full_name: 'Current Rider',
      created_date: '2026-10-14T02:00:00.000Z',
    };

    expect(sortProfilesNewestFirst([legacyRider, currentRider]).map((profile) => profile.id))
      .toEqual(['current-rider', 'legacy-rider']);
  });

  it('selects the most recently active duplicate Rider profile', () => {
    const first = { id: 'old', user_id: 'rider-1', created_date: '2026-10-10T10:00:00.000Z' };
    const second = { id: 'new', user_id: 'rider-1', updated_date: '2026-10-11T10:00:00.000Z' };

    expect(newest(first, second)).toBe(second);
  });

  it('repairs only blank Rider identity fields from that Rider’s recorded trip', () => {
    const profile = {
      id: 'rider-1',
      user_id: 'rider-1',
      full_name: '',
      phone: '+233595167067',
      email: '',
    };
    const ride = {
      rider_id: 'rider-1',
      rider_name: 'Emmanuel Owusu',
      rider_phone: '+233244000111',
      rider_email: 'EMMANUEL@example.com',
    };

    expect(riderIdentityRecoveryPatch(profile, ride)).toEqual({
      full_name: 'Emmanuel Owusu',
      email: 'emmanuel@example.com',
      identity_recovered_from_ride: true,
    });
  });

  it('does not promote a generic ride label into an account name', () => {
    expect(riderIdentityRecoveryPatch(
      { id: 'rider-2', user_id: 'rider-2', full_name: '', phone: '', email: '' },
      { rider_id: 'rider-2', rider_name: 'Rider', rider_phone: '+233241234567' },
    )).toEqual({ phone: '+233241234567', identity_recovered_from_ride: true });
  });

  it('recognizes a legacy Rider ride by the same normalized Ghana phone number', () => {
    expect(legacyRiderContactMatches(
      { id: 'new-phone-auth-uid', user_id: 'new-phone-auth-uid', phone: '+233 59 516 7067' },
      { rider_id: 'former-email-uid', rider_phone: '0595167067', rider_name: 'Emmanuel Owusu' },
    )).toBe(true);
  });

  it('does not match a legacy Rider ride when phone and email belong to another account', () => {
    expect(legacyRiderContactMatches(
      { id: 'rider-1', user_id: 'rider-1', phone: '+233595167067', email: 'first@example.com' },
      { rider_id: 'rider-2', rider_phone: '+233541220725', rider_email: 'second@example.com' },
    )).toBe(false);
  });

  it('repairs a blank Driver name only from that Driver’s assigned ride snapshot', () => {
    const patch = driverIdentityRecoveryPatch(
      { id: 'driver-1', user_id: 'driver-1', full_name: '', phone: '', approval_status: 'pending' },
      {
        driver_id: 'driver-1',
        driver_name: 'Kofi Mensah',
        driver: { name: 'Kofi Mensah', phone: '+233244000222' },
      },
    );

    expect(patch).toEqual({
      full_name: 'Kofi Mensah',
      phone: '+233244000222',
      identity_recovered_from_ride: true,
    });
    expect(patch).not.toHaveProperty('approval_status');
  });

  it('does not promote generic Driver fallback text into a Driver account name', () => {
    expect(driverIdentityRecoveryPatch(
      { id: 'driver-2', user_id: 'driver-2', full_name: '', phone: '' },
      { driver_id: 'driver-2', driver_name: 'HY3N Driver' },
    )).toEqual({});
  });
});
