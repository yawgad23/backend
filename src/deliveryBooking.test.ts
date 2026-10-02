import { describe, expect, it } from 'vitest';
import { deliveryDetailsInput, deliveryRideFields, isExpressDeliveryCategory } from './deliveryBooking';
import { driverOfferView } from './driverDeliveryOffer';

const delivery = {
  sender: { name: 'Yaw Mensah', phone: '0501234567' },
  recipient: { name: 'Ama Boateng', phone: '0241234567' },
  packageDescription: 'Sealed document envelope',
  pickupInstructions: 'Ask at reception',
  dropoffInstructions: 'Call at the gate',
};

describe('Express Delivery contract', () => {
  it('requires complete, bounded delivery details for an Express Delivery booking', () => {
    expect(deliveryDetailsInput.safeParse(delivery).success).toBe(true);
    expect(deliveryDetailsInput.safeParse({ ...delivery, recipient: { name: '', phone: '0241234567' } }).success).toBe(false);
    expect(isExpressDeliveryCategory('express_delivery')).toBe(true);
    expect(isExpressDeliveryCategory('standard')).toBe(false);
  });

  it('persists delivery information only as an immutable request snapshot', () => {
    const fields = deliveryRideFields(delivery);
    expect(fields.delivery_sender_name).toBe('Yaw Mensah');
    expect(fields.delivery_recipient_phone).toBe('0241234567');
    expect(fields.delivery_package_description).toBe('Sealed document envelope');
  });

  it('does not disclose delivery contacts while an offer is still unassigned', () => {
    const offer = driverOfferView({
      id: 'ride-1',
      category: 'express_delivery',
      rider_name: 'Yaw Mensah',
      rider_phone: '0501234567',
      pickup_address: 'Adenta',
      destination_address: 'Osu',
      ...deliveryRideFields(delivery),
    });
    expect(offer.rider_name).toBe('Delivery request');
    expect(offer.delivery_has_contact_details).toBe(true);
    expect(offer).not.toHaveProperty('delivery');
    expect(offer).not.toHaveProperty('delivery_sender_phone');
    expect(offer).not.toHaveProperty('delivery_recipient_phone');
  });
});
