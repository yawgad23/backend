import { describe, expect, it } from 'vitest';
import {
  disabledDriverPayoutSummary,
  directDriverCollectionTotal,
  isDirectDriverCollection,
  rejectDriverPayoutRequest,
} from './driverCashCollectionPolicy';

const fare = (ride: Record<string, unknown>) => Number(ride.final_fare || 0);
const tip = (ride: Record<string, unknown>) => Number(ride.tip_amount || 0);

describe('Driver direct-collection payout policy', () => {
  it('recognises cash and direct mobile-money fares as Driver-collected money', () => {
    expect(isDirectDriverCollection({ payment_method: 'cash' })).toBe(true);
    expect(isDirectDriverCollection({ payment_method: 'mobile_money', payment_collection: 'direct_to_driver' })).toBe(true);
    expect(isDirectDriverCollection({ payment_method: 'wallet' })).toBe(false);
  });

  it('reports direct collections as earnings but never as a withdrawal balance', () => {
    const rides = [
      { payment_method: 'cash', final_fare: 120, tip_amount: 5 },
      { payment_method: 'mobile_money', payment_collection: 'direct_to_driver', final_fare: 50, tip_amount: 0 },
      { payment_method: 'wallet', final_fare: 80, tip_amount: 0 },
    ];
    expect(directDriverCollectionTotal(rides, fare, tip)).toBe(175);
    expect(disabledDriverPayoutSummary()).toMatchObject({ enabled: false, availableBalance: 0 });
    expect(() => rejectDriverPayoutRequest()).toThrow(/does not hold Driver cash fares/i);
  });
});
