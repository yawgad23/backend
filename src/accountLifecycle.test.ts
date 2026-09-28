import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_RETENTION_REVIEW_MONTHS,
  accountIsDisabled,
  accountStatusPatch,
} from './accountLifecycle';

describe('account retention lifecycle', () => {
  it('disables suspended and inactive accounts, but not active accounts', () => {
    expect(accountIsDisabled('active')).toBe(false);
    expect(accountIsDisabled('suspended')).toBe(true);
    expect(accountIsDisabled('inactive')).toBe(true);
  });

  it('records a retention review date when an account is deactivated', () => {
    const now = new Date('2026-09-28T12:00:00.000Z');
    const patch = accountStatusPatch('inactive', 'self_service:user-123', now);

    expect(patch).toMatchObject({
      account_status: 'inactive',
      account_inactivated_at: '2026-09-28T12:00:00.000Z',
      account_inactivated_by: 'self_service:user-123',
      account_deletion_requested: true,
    });
    expect(patch.account_retention_review_after).toBe('2027-03-28T12:00:00.000Z');
    expect(ACCOUNT_RETENTION_REVIEW_MONTHS).toBe(6);
  });

  it('preserves the retention record while recording an authorized reactivation', () => {
    const patch = accountStatusPatch('active', 'admin@example.com', new Date('2026-09-28T12:00:00.000Z'));

    expect(patch).toMatchObject({
      account_status: 'active',
      account_reactivated_by: 'admin@example.com',
      account_deletion_requested: false,
    });
    expect(patch).not.toHaveProperty('account_retention_review_after');
  });
});
