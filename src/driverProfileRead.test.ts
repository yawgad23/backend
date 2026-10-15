import { describe, expect, it } from 'vitest';
import { selectAuthenticatedDriverProfile } from './driverProfileRead';

describe('selectAuthenticatedDriverProfile', () => {
  it('returns the newest profile already linked to the authenticated Driver UID', () => {
    const profile = selectAuthenticatedDriverProfile('driver-uid', [
      { id: 'legacy', user_id: 'driver-uid', approval_status: 'approved', updated_date: '2026-10-10T10:00:00.000Z' },
      { id: 'driver-uid', user_id: 'driver-uid', approval_status: 'approved', updated_date: '2026-10-15T10:00:00.000Z' },
    ]);

    expect(profile).toMatchObject({ id: 'driver-uid', user_id: 'driver-uid', approval_status: 'approved' });
  });

  it('never returns another Driver profile', () => {
    expect(selectAuthenticatedDriverProfile('driver-uid', [
      { id: 'other', user_id: 'other-uid', approval_status: 'approved' },
      { id: 'legacy', user_id: 'driver-uid', approval_status: 'pending' },
    ])).toMatchObject({ id: 'legacy', user_id: 'driver-uid' });
  });
});
