import { describe, expect, it } from 'vitest';
import { getAuthoritativeFinalFare, getQuotedRideFare, getTripChargeTotal, roundGhsFare } from '../src/fareAuthority';

describe('HY3N fare authority', () => {
  it('rounds .50 and lower down, and values above .50 up', () => {
    expect(roundGhsFare(78.11)).toBe(78);
    expect(roundGhsFare(78.5)).toBe(78);
    expect(roundGhsFare(78.51)).toBe(79);
  });

  it('uses the rider quote rather than a driver-reported recalculation', () => {
    const ride = { quoted_fare: 19, waiting_fee: 0, driver_reported_final_fare: 96.88 };
    expect(getQuotedRideFare(ride)).toBe(19);
    expect(getAuthoritativeFinalFare(ride)).toBe(19);
    expect(getTripChargeTotal(ride)).toBe(19);
  });

  it('includes only the recorded waiting fee in the authoritative final amount', () => {
    const ride = { quoted_fare: 19, waiting_fee: 2.8, driver_reported_final_fare: 96.88 };
    expect(getAuthoritativeFinalFare(ride)).toBe(22);
  });
});
