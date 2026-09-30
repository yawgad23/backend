export type DriverFeeBypass = {
  active: boolean;
  date: string;
  reason: string;
  grantedBy: string;
  grantedAt: string;
  revokedAt?: string | null;
  revokedBy?: string | null;
};

function dateOnly(value: unknown): string {
  const date = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '';
}

export function isDriverFeeBypassActive(profile: Record<string, any> | null | undefined, date: string): boolean {
  const bypass = profile?.driver_fee_bypass;
  if (!bypass || typeof bypass !== 'object') return false;
  return bypass.active === true
    && dateOnly(bypass.date) === date
    && !bypass.revokedAt
    && !bypass.revoked_at;
}

export function visibleDriverFeeBypass(profile: Record<string, any> | null | undefined, today: string): DriverFeeBypass | null {
  const bypass = profile?.driver_fee_bypass;
  if (!bypass || typeof bypass !== 'object') return null;
  const date = dateOnly(bypass.date);
  if (!date || bypass.active !== true || bypass.revokedAt || bypass.revoked_at) return null;
  return {
    active: true,
    date,
    reason: String(bypass.reason || 'Administrator-approved fee access').slice(0, 500),
    grantedBy: String(bypass.grantedBy || bypass.granted_by || ''),
    grantedAt: String(bypass.grantedAt || bypass.granted_at || ''),
    ...(date < today ? { active: false } : {}),
  };
}

export function buildDriverFeeBypass(
  date: string,
  reason: string,
  administrator: string,
  now: string,
): DriverFeeBypass {
  return {
    active: true,
    date,
    reason: reason.trim().slice(0, 500) || 'Administrator-approved test access',
    grantedBy: administrator,
    grantedAt: now,
    revokedAt: null,
    revokedBy: null,
  };
}

export function revokeDriverFeeBypass(
  current: DriverFeeBypass | null | undefined,
  administrator: string,
  now: string,
): Record<string, unknown> {
  return {
    ...(current || {}),
    active: false,
    revokedAt: now,
    revokedBy: administrator,
  };
}
