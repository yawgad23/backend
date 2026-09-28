export type AccountStatus = 'active' | 'suspended' | 'inactive';

export const ACCOUNT_RETENTION_REVIEW_MONTHS = 6;

export function accountIsDisabled(status: AccountStatus): boolean {
  return status !== 'active';
}

export function addCalendarMonths(date: Date, months: number): Date {
  const result = new Date(date);
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
}

export function accountStatusPatch(
  status: AccountStatus,
  changedBy: string,
  now = new Date(),
): Record<string, string | boolean | null> {
  const changedAt = now.toISOString();
  const patch: Record<string, string | boolean | null> = {
    account_status: status,
    account_status_updated_at: changedAt,
    account_status_updated_by: changedBy,
  };

  if (status === 'inactive') {
    patch.account_inactivated_at = changedAt;
    patch.account_inactivated_by = changedBy;
    patch.account_retention_review_after = addCalendarMonths(now, ACCOUNT_RETENTION_REVIEW_MONTHS).toISOString();
    patch.account_deletion_requested = true;
    return patch;
  }

  if (status === 'active') {
    patch.account_reactivated_at = changedAt;
    patch.account_reactivated_by = changedBy;
    patch.account_deletion_requested = false;
  }

  return patch;
}
