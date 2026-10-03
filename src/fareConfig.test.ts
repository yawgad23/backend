import { describe, expect, it } from 'vitest';
import { normalizeFareCategory, normalizeFareRate, validateFareRateUpdate } from './fareConfig';

describe('fare configuration validation', () => {
  it('only accepts HY3N category identifiers', () => {
    expect(normalizeFareCategory('comfort')).toBe('comfort');
    expect(normalizeFareCategory('unknown-category')).toBe('standard');
  });

  it('keeps persisted pricing within supported bounds', () => {
    const rate = normalizeFareRate({ baseFare: 18, pricePerKm: 5, pricePerMinute: 0.7, minFare: 28, bookingFee: 3, waitingFeePerMinute: 0.9, isActive: false }, 'comfort');
    expect(rate).toMatchObject({ category: 'comfort', baseFare: 18, pricePerKm: 5, pricePerMinute: 0.7, minFare: 28, bookingFee: 3, waitingFeePerMinute: 0.9, isActive: false });
  });

  it('removes a legacy booking fee from new settings', () => {
    expect(validateFareRateUpdate({ minFare: 1, bookingFee: 2 }, 'standard')).toMatchObject({ minFare: 1, bookingFee: 0 });
  });

  it('keeps the approved Standard short-trip cap configuration', () => {
    const rate = validateFareRateUpdate({
      baseFare: 10,
      pricePerKm: 3.65,
      pricePerMinute: 0.43,
      minFare: 16.5,
      bookingFee: 2.5,
      waitingFeePerMinute: 0.55,
      shortTripCap: 19,
      shortTripMaxDistanceKm: 2,
      shortTripMaxDurationMinutes: 10,
      isActive: true,
    }, 'standard');
    expect(rate).toMatchObject({ shortTripCap: 19, shortTripMaxDistanceKm: 2, shortTripMaxDurationMinutes: 10 });
  });

  it('rejects an incomplete Standard short-trip cap configuration', () => {
    expect(() => validateFareRateUpdate({ shortTripCap: 19, shortTripMaxDistanceKm: 2 }, 'standard'))
      .toThrow('Provide the Standard short-trip cap');
  });

  it('retains historic snapshot fees but removes them from all new fare configurations', () => {
    expect(normalizeFareRate({ bookingFee: 2.5 }, 'standard').bookingFee).toBe(2.5);
    expect(validateFareRateUpdate({ bookingFee: 2.5 }, 'standard').bookingFee).toBe(0);
  });
});
