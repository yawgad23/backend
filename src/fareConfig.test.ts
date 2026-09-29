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

  it('rejects a minimum below the booking fee', () => {
    expect(() => validateFareRateUpdate({ minFare: 1, bookingFee: 2 }, 'standard')).toThrow('Minimum fare');
  });
});
