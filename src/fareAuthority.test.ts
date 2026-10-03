import { describe, expect, it } from 'vitest';
import {
  canCancelRideBeforeTrip,
  cancelledRideNoChargePatch,
  getCappedCompatibilityDistanceKm,
  getTripChargeTotal,
  getMeteredFareBreakdown,
  getMeteredTripFare,
  getTripDurationMinutes,
  getWaitingCharge,
  requiresRiderCancellationReason,
} from './fareAuthority';
import { advanceTripMeter, initializeTripMeter } from './tripMeter';

describe('metered trip fares', () => {
  it('does not reuse a booked route estimate when a trip has no travel', () => {
    const fare = getMeteredTripFare({
      category: 'standard',
      distanceKm: 0,
      durationMinutes: 0,
      waitingFee: 0,
    });

    // The Standard minimum is allowed, but a GH₵69 booking
    // quote can never become the completed fare when no distance was recorded.
    expect(fare).toBe(16);
    expect(fare).toBeLessThan(69);
  });

  it('includes only post-start distance, elapsed time, and recorded waiting fee', () => {
    const breakdown = getMeteredFareBreakdown({
      category: 'standard',
      distanceKm: 10,
      durationMinutes: 20,
      waitingFee: 2.2,
    });

    expect(breakdown.distanceFare).toBeCloseTo(36.5, 5);
    expect(breakdown.timeFare).toBeCloseTo(8.6, 5);
    expect(breakdown.waitingFee).toBe(2.2);
    expect(breakdown.total).toBe(57);
  });

  it('uses a stored category rate snapshot instead of a later default rate', () => {
    const breakdown = getMeteredFareBreakdown({
      category: 'standard',
      distanceKm: 5,
      durationMinutes: 10,
      surgeMultiplier: 1,
      fareRate: {
        baseFare: 20,
        pricePerKm: 4,
        pricePerMinute: 1,
        minFare: 30,
        bookingFee: 3,
        isActive: true,
      },
    });

    expect(breakdown.baseFare).toBe(20);
    expect(breakdown.distanceRate).toBe(4);
    expect(breakdown.timeRate).toBe(1);
    expect(breakdown.bookingFee).toBe(3);
    expect(breakdown.total).toBe(53);
  });

  it('uses server time only after the recorded Start Trip timestamp', () => {
    expect(getTripDurationMinutes('2026-09-24T15:00:00.000Z', Date.parse('2026-09-24T15:15:00.000Z'))).toBe(15);
    expect(getTripDurationMinutes('not-a-date', Date.now())).toBe(0);
  });

  it('caps eligible Standard short rides at GH₵19 before paid waiting', () => {
    const breakdown = getMeteredFareBreakdown({
      category: 'standard',
      distanceKm: 1.8,
      durationMinutes: 9,
      waitingFee: 2.2,
      fareRate: {
        baseFare: 10,
        pricePerKm: 5,
        pricePerMinute: 0.8,
        minFare: 16.5,
        bookingFee: 2.5,
        waitingFeePerMinute: 0.55,
        shortTripCap: 19,
        shortTripMaxDistanceKm: 2,
        shortTripMaxDurationMinutes: 10,
        isActive: true,
      },
    });
    expect(breakdown).toMatchObject({ shortTripCap: 19, shortTripCapApplied: true, waitingFee: 2.2, total: 21 });
  });

  it('does not cap Standard trips outside either approved short-trip limit', () => {
    const breakdown = getMeteredFareBreakdown({
      category: 'standard',
      distanceKm: 2.1,
      durationMinutes: 9,
      fareRate: {
        baseFare: 10,
        pricePerKm: 5,
        pricePerMinute: 0.8,
        minFare: 16.5,
        bookingFee: 2.5,
        waitingFeePerMinute: 0.55,
        shortTripCap: 19,
        shortTripMaxDistanceKm: 2,
        shortTripMaxDurationMinutes: 10,
        isActive: true,
      },
    });
    expect(breakdown.shortTripCapApplied).toBe(false);
    expect(breakdown.total).toBeGreaterThan(19);
  });

  it('charges only post-free waiting from server arrival and Start Trip timestamps', () => {
    const charge = getWaitingCharge({
      category: 'standard',
      fareRate: { baseFare: 10, pricePerKm: 3.65, pricePerMinute: 0.43, minFare: 16.5, bookingFee: 2.5, waitingFeePerMinute: 0.6, isActive: true },
      arrivedAt: '2026-09-29T12:00:00.000Z',
      tripStartedAt: '2026-09-29T12:08:30.000Z',
    });

    expect(charge).toEqual({ waitedMinutes: 8.5, chargeableMinutes: 5.5, ratePerMinute: 0.6, waitingFee: 3.3 });
    expect(getWaitingCharge({ category: 'standard', arrivedAt: 'not-a-date', tripStartedAt: '2026-09-29T12:08:30.000Z' }).waitingFee).toBe(0);
  });

  it('caps compatibility distance without ever turning zero into the booking estimate', () => {
    expect(getCappedCompatibilityDistanceKm(0, 10)).toBe(0);
    expect(getCappedCompatibilityDistanceKm(100, 10)).toBe(14);
    expect(getCappedCompatibilityDistanceKm(undefined, 10)).toBeNull();
  });

  it('never charges a cancelled ride for waiting, a stored final fare, or a tip', () => {
    const patch = cancelledRideNoChargePatch({
      cancelledBy: 'rider',
      reason: 'Plans changed',
      cancelledAt: '2026-09-29T12:10:00.000Z',
    });
    expect(patch).toMatchObject({ status: 'cancelled', waiting_fee: 0, final_fare: 0, driver_earnings: 0 });
    expect(getTripChargeTotal({ status: 'cancelled', waiting_fee: 25, final_fare: 100, tip_amount: 10 })).toBe(0);
  });

  it('allows cancellation only before Start Trip', () => {
    expect(canCancelRideBeforeTrip({ status: 'driver_arrived' })).toBe(true);
    expect(canCancelRideBeforeTrip({ status: 'in_progress', trip_started_at: '2026-09-29T12:00:00.000Z' })).toBe(false);
    expect(canCancelRideBeforeTrip({ status: 'completed' })).toBe(false);
    expect(canCancelRideBeforeTrip({ status: 'cancelled' })).toBe(false);
  });

  it('requires a Rider cancellation reason only after a Driver is connected', () => {
    expect(requiresRiderCancellationReason({ status: 'searching', driver_id: null })).toBe(false);
    expect(requiresRiderCancellationReason({ status: 'searching', driver_id: 'driver-1' })).toBe(true);
    expect(requiresRiderCancellationReason({ status: 'matched', driver_id: null })).toBe(true);
    expect(requiresRiderCancellationReason({ status: 'driver_arriving', driver: { id: 'driver-2' } })).toBe(true);
    expect(requiresRiderCancellationReason({ status: 'in_progress' })).toBe(false);
  });
});

describe('server trip meter', () => {
  it('counts plausible movement but rejects GPS drift and teleport jumps', () => {
    const startedAt = '2026-09-24T15:00:00.000Z';
    let meter = initializeTripMeter(startedAt, { latitude: 5.6037, longitude: -0.187 });

    const noise = advanceTripMeter(meter, { latitude: 5.60371, longitude: -0.187 }, '2026-09-24T15:00:05.000Z');
    meter = noise.meter;
    expect(noise.accepted).toBe(false);
    expect(noise.ignoredReason).toBe('noise');
    expect(meter.distance_km).toBe(0);

    const movement = advanceTripMeter(meter, { latitude: 5.6042, longitude: -0.187 }, '2026-09-24T15:00:30.000Z');
    meter = movement.meter;
    expect(movement.accepted).toBe(true);
    expect(meter.distance_km).toBeGreaterThan(0.025);

    const jump = advanceTripMeter(meter, { latitude: 6.6037, longitude: -0.187 }, '2026-09-24T15:00:35.000Z');
    expect(jump.accepted).toBe(false);
    expect(jump.ignoredReason).toBe('jump');
    expect(jump.meter.distance_km).toBe(meter.distance_km);
  });

  it('validates a final GPS sample in the completion request', () => {
    const startedAt = '2026-09-24T15:00:00.000Z';
    const meter = initializeTripMeter(startedAt, { latitude: 5.6037, longitude: -0.187 });
    const finalSample = advanceTripMeter(
      meter,
      { latitude: 5.6042, longitude: -0.187 },
      '2026-09-24T15:00:30.000Z',
    );

    expect(finalSample.accepted).toBe(true);
    expect(finalSample.meter.accepted_samples).toBe(1);
    expect(finalSample.meter.distance_km).toBeGreaterThan(0.025);
  });
});
