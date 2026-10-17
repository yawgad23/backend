import { describe, expect, it } from 'vitest';
import { driverOfferView } from './driverDeliveryOffer';

const protectedPricingFields = [
  'final_fare',
  'fare_rate_snapshot',
  'quote_breakdown',
  'surge_multiplier',
];

describe('Driver pre-acceptance offer projection', () => {
  it('shows the server-saved booked fare but not rate or settlement internals before a standard ride is accepted', () => {
    const offer = driverOfferView({
      id: 'ride-1', status: 'searching', category: 'standard', rider_name: 'Rider',
      pickup_address: 'Pickup', destination_address: 'Destination', payment_method: 'cash',
      fare: 21, quoted_fare: 21, fare_estimate: 21, base_fare: 8, final_fare: 100,
      fare_rate_snapshot: { base: 8 }, quote_breakdown: { total: 21 }, surge_multiplier: 2,
    });
    expect(offer).toMatchObject({
      id: 'ride-1',
      pickup_address: 'Pickup',
      destination_address: 'Destination',
      quoted_fare: 21,
      fare_estimate: 21,
      base_fare: 8,
      fare: 21,
    });
    for (const key of protectedPricingFields) expect(offer).not.toHaveProperty(key);
  });

  it('keeps the booked fare but removes Delivery contact information until acceptance', () => {
    const offer = driverOfferView({
      id: 'delivery-1', status: 'searching', category: 'express_delivery',
      pickup_address: 'Pickup', destination_address: 'Destination', payment_method: 'cash',
      rider_phone: 'private', delivery_sender_phone: 'private', delivery_recipient_phone: 'private',
      quoted_fare: 30,
    });
    expect(offer).toMatchObject({ rider_name: 'Delivery request', delivery_has_contact_details: true, quoted_fare: 30 });
    expect(offer).not.toHaveProperty('rider_phone');
    expect(offer).not.toHaveProperty('delivery_sender_phone');
    expect(offer).not.toHaveProperty('delivery_recipient_phone');
  });

  it('also shows the booked fare on a scheduled pre-reservation offer', () => {
    const offer = driverOfferView({
      id: 'scheduled-1', status: 'scheduled', category: 'standard',
      pickup_address: 'Pickup', destination_address: 'Destination', quoted_fare: 48,
    });
    expect(offer).toMatchObject({ id: 'scheduled-1', status: 'scheduled', quoted_fare: 48 });
  });
});
