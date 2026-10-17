import { isDeliveryCategory } from './deliveryBooking';

/**
 * A Driver can assess pickup, destination, category and payment method before
 * accepting. Monetary quote/rate fields are intentionally absent: the server
 * does not disclose a booked fare until an authenticated Driver accepts.
 */
const PRE_ACCEPT_OFFER_FIELDS = [
  'id',
  'status',
  'category',
  'pickup',
  'pickup_address',
  'pickup_location',
  'destination',
  'destination_address',
  'dropoff_location',
  'stops',
  'payment',
  'payment_method',
  'payment_display_name',
  'rider_name',
  'rider_rating',
  'rider_rating_count',
  'distance',
  'distance_km',
  'estimated_distance_km',
  'estimated_duration_minutes',
  'pickup_distance_km',
  'driver_offer_attempt',
  'driver_offer_issued_at',
  'driver_offer_expires_at',
] as const;

/**
 * A pre-acceptance response is deliberately constructed rather than copied and
 * redacted. This prevents new fare, contact or internal settlement fields from
 * becoming visible when the Ride schema grows.
 */
export function driverOfferView(ride: Record<string, unknown>): Record<string, unknown> {
  const offer: Record<string, unknown> = {};
  for (const key of PRE_ACCEPT_OFFER_FIELDS) {
    if (ride[key] !== undefined) offer[key] = ride[key];
  }

  if (isDeliveryCategory(ride.category)) {
    offer.rider_name = 'Delivery request';
    offer.delivery_has_contact_details = true;
  }
  return offer;
}
