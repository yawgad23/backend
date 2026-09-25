import { describe, expect, it } from 'vitest';
import { driverApprovalState, isApprovedDriverProfile } from './driverApproval';

describe('Driver approval policy', () => {
  it('requires an explicit admin approval before a Driver can be dispatchable', () => {
    expect(isApprovedDriverProfile({ approval_status: 'approved' })).toBe(true);
    expect(isApprovedDriverProfile({ approval_status: 'approved', account_status: 'suspended' })).toBe(false);
    expect(isApprovedDriverProfile({ approval_status: 'pending' })).toBe(false);
    expect(isApprovedDriverProfile({ approval_status: 'rejected' })).toBe(false);
    expect(isApprovedDriverProfile({})).toBe(false);
    expect(isApprovedDriverProfile(null)).toBe(false);
  });

  it('supports the legacy approved flags without treating unknown profiles as approved', () => {
    expect(driverApprovalState({ approved: true })).toBe('approved');
    expect(driverApprovalState({ is_approved: true })).toBe('approved');
    expect(driverApprovalState({ application_status: 'rejected', approved: true })).toBe('rejected');
    expect(driverApprovalState({ application_status: 'not-reviewed' })).toBe('pending');
  });
});
