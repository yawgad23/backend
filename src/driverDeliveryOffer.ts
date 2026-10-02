import { isExpressDeliveryCategory } from './deliveryBooking';

const PRIVATE_DELIVERY_FIELDS = [
  'delivery',
  'delivery_sender_name',
  'delivery_sender_phone',
  'delivery_recipient_name',
  'delivery_recipient_phone',
  'delivery_package_description',
  'delivery_pickup_instructions',
  'delivery_dropoff_instructions',
  'rider_phone',
  'passenger_name',
  'passenger_phone',
  'passenger_pickup_note',
  'booked_by_name',
  'booked_by_phone',
] as const;

/**
 * A Driver can assess the pickup route before accepting but cannot see sender
 * or recipient contact information until the delivery is assigned to them.
 */
export function driverOfferView(ride: Record<string, unknown>): Record<string, unknown> {
  if (!isExpressDeliveryCategory(ride.category)) return ride;

  const offer = { ...ride };
  for (const key of PRIVATE_DELIVERY_FIELDS) delete offer[key];
  return {
    ...offer,
    rider_name: 'Delivery request',
    delivery_has_contact_details: true,
  };
}
