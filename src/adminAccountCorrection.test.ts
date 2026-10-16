import { describe, expect, it } from 'vitest';
import {
  adminAccountIdentityCorrectionInput,
  correctedIdentityFields,
} from './adminAccountRoutes';

describe('admin account identity correction safeguards', () => {
  it('normalizes a valid Rider correction and requires an audit reason', () => {
    expect(adminAccountIdentityCorrectionInput({
      role: 'rider',
      fullName: '  Yaw   Gad ',
      email: 'YAW@Example.COM ',
      phone: '0541 220 725',
      reason: 'Corrected a phone number entered with a digit missing.',
    })).toEqual({
      correction: {
        role: 'rider',
        fullName: 'Yaw Gad',
        email: 'yaw@example.com',
        phone: '+233541220725',
        reason: 'Corrected a phone number entered with a digit missing.',
      },
      error: null,
    });
  });

  it('rejects missing reason, placeholder name, non-Ghana phone, and unsupported role', () => {
    expect(adminAccountIdentityCorrectionInput({
      role: 'rider', fullName: 'Rider', email: 'rider@example.com', phone: '0541220725', reason: 'Fix',
    }).error).toContain('real full name');
    expect(adminAccountIdentityCorrectionInput({
      role: 'rider', fullName: 'Yaw Gad', email: 'rider@example.com', phone: '+15551234567', reason: 'Fix',
    }).error).toContain('Ghana mobile');
    expect(adminAccountIdentityCorrectionInput({
      role: 'admin', fullName: 'Yaw Gad', email: 'rider@example.com', phone: '0541220725', reason: 'Fix',
    }).error).toContain('Rider or Driver');
    expect(adminAccountIdentityCorrectionInput({
      role: 'driver', fullName: 'Yaw Gad', email: 'rider@example.com', phone: '0541220725', reason: '  ',
    }).error).toContain('reason');
  });

  it('audits only identity fields that changed, not account status, payments, or rides', () => {
    const changed = correctedIdentityFields({
      full_name: 'Yaw Gad', email: 'yaw@example.com', phone: '+233541220725',
      account_status: 'approved', total_rides: 23, wallet_balance: 100,
    }, {
      fullName: 'Yaw K. Gad', email: 'yaw@example.com', phone: '+233541220725',
    });
    expect(changed).toEqual(['full name']);
    expect(changed).not.toContain('account status');
    expect(changed).not.toContain('wallet balance');
  });
});
