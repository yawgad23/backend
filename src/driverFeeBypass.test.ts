import { describe, expect, it } from 'vitest';
import { buildDriverFeeBypass, isDriverFeeBypassActive, revokeDriverFeeBypass } from './driverFeeBypass';
import { canPassDriverPlatformFeeGate } from './driverRouters';

describe('Driver fee bypass', () => {
  const date = '2026-09-30';
  const bypass = buildDriverFeeBypass(date, 'Supervised wallet and fee flow test', 'admin@example.com', '2026-09-30T12:00:00.000Z');

  it('is valid only for the explicitly granted date', () => {
    expect(isDriverFeeBypassActive({ driver_fee_bypass: bypass }, date)).toBe(true);
    expect(isDriverFeeBypassActive({ driver_fee_bypass: bypass }, '2026-10-01')).toBe(false);
  });

  it('stops immediately when an administrator revokes it', () => {
    const revoked = revokeDriverFeeBypass(bypass, 'admin@example.com', '2026-09-30T13:00:00.000Z');
    expect(isDriverFeeBypassActive({ driver_fee_bypass: revoked }, date)).toBe(false);
  });

  it('allows an active bypass through the nearby-offer fee gate without marking a payment as paid', () => {
    expect(canPassDriverPlatformFeeGate({ driver_fee_bypass: bypass }, false, date)).toBe(true);
    expect(canPassDriverPlatformFeeGate({ driver_fee_bypass: bypass }, false, '2026-10-01')).toBe(false);
    expect(canPassDriverPlatformFeeGate({}, false, date)).toBe(false);
  });
});
