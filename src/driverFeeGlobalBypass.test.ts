import { describe, expect, it } from 'vitest';
import {
  buildGlobalDriverFeeBypass,
  isGlobalDriverFeeBypassActive,
  revokeGlobalDriverFeeBypass,
  visibleGlobalDriverFeeBypass,
} from './driverFeeGlobalBypass';
import { canPassDriverPlatformFeeGate } from './driverRouters';

describe('global Driver fee bypass', () => {
  const date = '2026-10-15';
  const bypass = buildGlobalDriverFeeBypass(
    date,
    'Payment provider maintenance',
    'admin@example.com',
    '2026-10-15T10:00:00.000Z',
  );

  it('is active only for the exact operational date', () => {
    expect(isGlobalDriverFeeBypassActive(bypass, date)).toBe(true);
    expect(isGlobalDriverFeeBypassActive(bypass, '2026-10-16')).toBe(false);
    expect(visibleGlobalDriverFeeBypass(bypass, date)).toMatchObject({
      active: true,
      date,
      scope: 'all_approved_drivers',
    });
  });

  it('stops immediately when revoked', () => {
    const revoked = revokeGlobalDriverFeeBypass(bypass, 'admin@example.com', '2026-10-15T10:05:00.000Z');
    expect(isGlobalDriverFeeBypassActive(revoked, date)).toBe(false);
  });

  it('can pass the fee gate without creating a Driver payment record', () => {
    expect(canPassDriverPlatformFeeGate({}, false, date, bypass)).toBe(true);
    expect(canPassDriverPlatformFeeGate({}, false, '2026-10-16', bypass)).toBe(false);
  });
});
