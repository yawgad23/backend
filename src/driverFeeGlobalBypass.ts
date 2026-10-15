export const PLATFORM_SETTINGS_COLLECTION = 'platform_settings';
export const GLOBAL_DRIVER_FEE_BYPASS_DOCUMENT = 'driver_fee_bypass_all_drivers';

export type GlobalDriverFeeBypass = {
  active: boolean;
  date: string;
  reason: string;
  grantedBy: string;
  grantedAt: string;
  revokedAt?: string | null;
  revokedBy?: string | null;
  scope: 'all_approved_drivers';
};

function dateOnly(value: unknown): string {
  const date = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '';
}

/**
 * A global bypass is a same-day operational pass only. It never marks a fee
 * paid and it never overrides account approval, availability, or suspension.
 */
export function isGlobalDriverFeeBypassActive(
  setting: Record<string, any> | null | undefined,
  date: string,
): boolean {
  return setting?.active === true
    && setting?.scope === 'all_approved_drivers'
    && dateOnly(setting?.date) === date
    && !setting?.revokedAt
    && !setting?.revoked_at;
}

export function visibleGlobalDriverFeeBypass(
  setting: Record<string, any> | null | undefined,
  today: string,
): GlobalDriverFeeBypass | null {
  if (!setting || !isGlobalDriverFeeBypassActive(setting, today)) return null;
  return {
    active: true,
    date: today,
    reason: String(setting.reason || 'Administrator-approved all-Driver fee access').slice(0, 500),
    grantedBy: String(setting.grantedBy || setting.granted_by || ''),
    grantedAt: String(setting.grantedAt || setting.granted_at || ''),
    revokedAt: null,
    revokedBy: null,
    scope: 'all_approved_drivers',
  };
}

export function buildGlobalDriverFeeBypass(
  date: string,
  reason: string,
  administrator: string,
  now: string,
): GlobalDriverFeeBypass {
  return {
    active: true,
    date,
    reason: reason.trim().slice(0, 500) || 'Administrator-approved all-Driver fee access',
    grantedBy: administrator,
    grantedAt: now,
    revokedAt: null,
    revokedBy: null,
    scope: 'all_approved_drivers',
  };
}

export function revokeGlobalDriverFeeBypass(
  current: GlobalDriverFeeBypass | null | undefined,
  administrator: string,
  now: string,
): Record<string, unknown> {
  return {
    ...(current || { scope: 'all_approved_drivers' }),
    active: false,
    revokedAt: now,
    revokedBy: administrator,
  };
}
