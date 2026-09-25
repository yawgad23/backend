import { describe, expect, it } from 'vitest';
import {
  completedRidesForPeriod,
  earningsTrend,
  numericRideFare,
  numericTip,
  paidFeesForPeriod,
} from './driverEarnings';

const reference = new Date('2026-09-25T12:00:00.000Z');

describe('Driver earnings aggregation', () => {
  const rides = [
    { status: 'completed', completed_at: '2026-09-25T07:15:00.000Z', final_fare: 69, tip_amount: 5 },
    { status: 'completed', completed_at: '2026-09-23T10:00:00.000Z', fare: 50, tip_amount: 0 },
    { status: 'completed', completed_at: '2026-08-20T10:00:00.000Z', fare_estimate: 42, tip_amount: 1 },
    { status: 'cancelled', completed_at: '2026-09-25T08:00:00.000Z', final_fare: 100 },
  ];

  it('includes only completed rides in the selected UTC period', () => {
    expect(completedRidesForPeriod(rides, 'today', reference)).toHaveLength(1);
    expect(completedRidesForPeriod(rides, 'week', reference)).toHaveLength(2);
    expect(completedRidesForPeriod(rides, 'month', reference)).toHaveLength(2);
  });

  it('uses the final server fare and ignores invalid numeric values', () => {
    expect(numericRideFare(rides[0])).toBe(69);
    expect(numericRideFare({ final_fare: 'not-a-fare' })).toBe(0);
    expect(numericTip(rides[0])).toBe(5);
    expect(numericTip({ tip_amount: -5 })).toBe(0);
  });

  it('aggregates a daily earnings trend including tips', () => {
    expect(earningsTrend(completedRidesForPeriod(rides, 'week', reference))).toEqual([
      { date: '2026-09-23', amount: 50 },
      { date: '2026-09-25', amount: 74 },
    ]);
  });

  it('uses paid fee records only in the selected period', () => {
    const fees = [
      { status: 'paid', date: '2026-09-25', amount: 0.1 },
      { status: 'processing', date: '2026-09-25', amount: 0.1 },
      { status: 'completed', date: '2026-09-20', amount: 50 },
    ];
    expect(paidFeesForPeriod(fees, 'today', reference)).toEqual([fees[0]]);
    expect(paidFeesForPeriod(fees, 'week', reference)).toEqual([fees[0], fees[2]]);
  });
});
