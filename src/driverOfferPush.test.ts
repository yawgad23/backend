import { describe, expect, it } from 'vitest';
import { driverOfferRecipients } from './driverOfferPush';

const now = Date.parse('2026-10-03T21:00:00.000Z');
const ride = {
  id: 'ride-1',
  status: 'searching',
  category: 'standard',
  pickup: { lat: 5.6037, lng: -0.187 },
};

function presence(overrides: Record<string, unknown> = {}) {
  return {
    id: 'driver-1',
    user_id: 'driver-1',
    is_online: true,
    availability_status: 'online',
    approval_status: 'approved',
    approved: true,
    ride_categories: ['standard'],
    pickup_radius_km: 10,
    current_location: {
      latitude: 5.604,
      longitude: -0.1872,
      recorded_at: new Date(now - 20_000).toISOString(),
    },
    ...overrides,
  };
}

describe('Driver ride-offer push recipients', () => {
  it('wakes only fresh nearby Drivers who serve the requested category', () => {
    expect(driverOfferRecipients(ride, [
      presence(),
      presence({ id: 'too-far', user_id: 'too-far', current_location: { latitude: 5.9, longitude: -0.187, recorded_at: new Date(now - 20_000).toISOString() } }),
      presence({ id: 'stale', user_id: 'stale', current_location: { latitude: 5.604, longitude: -0.1872, recorded_at: new Date(now - 10 * 60_000).toISOString() } }),
      presence({ id: 'wrong-type', user_id: 'wrong-type', ride_categories: ['express_delivery'] }),
    ], now)).toEqual(['driver-1']);
  });

  it('keeps recipient selection ordered by pickup distance and bounded', () => {
    const drivers = Array.from({ length: 20 }, (_, index) => presence({
      id: `driver-${index}`,
      user_id: `driver-${index}`,
      current_location: {
        latitude: 5.6037 + (index + 1) / 10_000,
        longitude: -0.187,
        recorded_at: new Date(now - 20_000).toISOString(),
      },
    }));
    const recipients = driverOfferRecipients(ride, drivers, now);
    expect(recipients).toHaveLength(12);
    expect(recipients[0]).toBe('driver-0');
    expect(recipients[11]).toBe('driver-11');
  });

  it('does not wake a Driver who cancelled the same request during re-dispatch', () => {
    const redispatchedRide = { ...ride, declined_by_driver_ids: ['driver-1'] };

    expect(driverOfferRecipients(redispatchedRide, [
      presence(),
      presence({ id: 'driver-2', user_id: 'driver-2' }),
    ], now)).toEqual(['driver-2']);
  });

  it('sends Car Delivery requests only to opted-in car Drivers, including legacy Executive cars', () => {
    const carDeliveryRide = { ...ride, category: 'car_delivery' };
    expect(driverOfferRecipients(carDeliveryRide, [
      presence({ id: 'legacy-executive', user_id: 'legacy-executive', ride_categories: ['executive'] }),
      presence({ id: 'car-delivery', user_id: 'car-delivery', ride_categories: ['car_delivery'] }),
      presence({ id: 'standard-only', user_id: 'standard-only', ride_categories: ['standard'] }),
      presence({ id: 'parcel-driver', user_id: 'parcel-driver', service_type: 'delivery', ride_categories: ['express_delivery'] }),
    ], now)).toEqual(['legacy-executive', 'car-delivery']);
  });
});
