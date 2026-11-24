import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ get: vi.fn(), list: vi.fn() }));
vi.mock('./firebaseAdmin', () => ({ ADMIN_COLLECTIONS: { DRIVER_PROFILES: 'driver_profiles' },
  adminFirestore: mocks, getAdminDb: vi.fn() }));
import { driverApprovalState, driverProfileForUserId, isApprovedDriverProfile, preferredDriverProfile,
  selectOwnedDriverProfile, DriverProfileAuthorityError } from './driverApproval';
const uid = 'driver-uid';
const legacy = { id: 'legacy', user_id: uid, full_name: 'Kofi Mensah', approval_status: 'approved' };

describe('Driver approval policy', () => {
  it.each(['pending', 'rejected'])('explicit %s overrides stale boolean approval', (status) => {
    expect(driverApprovalState({ approval_status: status, approved: true, is_approved: true })).toBe(status);
    expect(driverApprovalState({ application_status: status, approved: true })).toBe(status);
    expect(isApprovedDriverProfile({ approval_status: status, approved: true })).toBe(false);
  });
  it('supports legacy booleans but never missing/unknown approval', () => {
    expect(driverApprovalState({ approved: true })).toBe('approved');
    expect(driverApprovalState({ is_approved: true })).toBe('approved');
    expect(driverApprovalState({ application_status: 'not-reviewed' })).toBe('pending');
    expect(isApprovedDriverProfile(null)).toBe(false);
    expect(isApprovedDriverProfile({})).toBe(false);
  });
  it.each(['suspended', 'inactive', 'removed', 'disabled'])('blocks lifecycle %s without changing approval', (status) => {
    expect(isApprovedDriverProfile({ approval_status: 'approved', account_status: status })).toBe(false);
    expect(isApprovedDriverProfile({ approved: true, status })).toBe(false);
  });
  it.each(['pending', 'rejected', 'approved'])('canonical %s is authoritative even when alias is newer/approved', (status) => {
    const canonical = { id: uid, user_id: uid, approval_status: status, updated_date: '2020' };
    expect(selectOwnedDriverProfile(uid, [{ ...legacy, updated_date: '2030' }, canonical])).toEqual(canonical);
    expect(preferredDriverProfile([legacy, canonical], uid)).toEqual(canonical);
  });
  it('accepts an owned canonical application without redundant user_id', () => {
    expect(selectOwnedDriverProfile(uid, [{ id: uid, approval_status: 'pending' }, legacy])?.id).toBe(uid);
  });
  it('keeps a genuinely approved legacy application when UID is only a presence/preferences stub', () => {
    const stub = { id: uid, user_id: uid, is_online: true, vehicle_make: 'Toyota', ride_categories: ['standard'], updated_date: '2030' };
    expect(selectOwnedDriverProfile(uid, [stub, legacy])).toEqual(legacy);
    expect(selectOwnedDriverProfile(uid, [legacy])).toEqual(legacy);
  });
  it('a suspended UID stub never reactivates an approved legacy account', () => {
    expect(isApprovedDriverProfile(selectOwnedDriverProfile(uid, [legacy, { id: uid, user_id: uid, account_status: 'suspended' }]))).toBe(false);
  });
  it('rejects canonical ownership collisions rather than falling back to an approved alias', () => {
    expect(() => selectOwnedDriverProfile(uid, [legacy, { id: uid, user_id: 'other', approval_status: 'pending' }])).toThrow(DriverProfileAuthorityError);
  });
  it('ignores unrelated profiles but fails conflicting legacy applications closed', () => {
    expect(selectOwnedDriverProfile(uid, [{ ...legacy, user_id: 'foreign' }])).toBeNull();
    expect(() => selectOwnedDriverProfile(uid, [legacy, { ...legacy, id: 'legacy-2', approval_status: 'pending' }])).toThrow(DriverProfileAuthorityError);
    expect(() => selectOwnedDriverProfile(uid, [legacy, { ...legacy, id: 'legacy-2', vehicle_plate: 'changed' }])).toThrow(DriverProfileAuthorityError);
  });
  it('identical legacy duplicates differ only by timestamps, not approval preference', () => {
    expect(selectOwnedDriverProfile(uid, [legacy, { ...legacy, id: 'legacy-2', updated_date: '2030' }])?.id).toBe('legacy');
  });
  it('bounded duplicate capacity fails safely', () => {
    expect(() => selectOwnedDriverProfile(uid, Array.from({ length: 21 }, (_, index) => ({ ...legacy, id: `legacy-${index}` })))).toThrow(DriverProfileAuthorityError);
  });
  it('public operational reader does not query around explicit canonical pending', async () => {
    mocks.get.mockResolvedValueOnce({ id: uid, user_id: uid, approval_status: 'pending' });
    expect(await driverProfileForUserId(uid)).toMatchObject({ id: uid, approval_status: 'pending' });
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it('public operational reader permits legacy fallback for a presence stub', async () => {
    mocks.get.mockResolvedValueOnce({ id: uid, user_id: uid, is_online: false });
    mocks.list.mockResolvedValueOnce([legacy]);
    expect(await driverProfileForUserId(uid)).toEqual(legacy);
  });
});
