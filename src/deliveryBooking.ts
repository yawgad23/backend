import { z } from 'zod';

export const EXPRESS_DELIVERY_CATEGORY = 'express_delivery';

const deliveryContactInput = z.object({
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(7).max(40),
});

export const deliveryDetailsInput = z.object({
  sender: deliveryContactInput,
  recipient: deliveryContactInput,
  packageDescription: z.string().trim().min(3).max(300),
  pickupInstructions: z.string().trim().max(500).optional(),
  dropoffInstructions: z.string().trim().max(500).optional(),
});

export type DeliveryDetails = z.infer<typeof deliveryDetailsInput>;

export function isExpressDeliveryCategory(category: unknown): boolean {
  return String(category || '').trim().toLowerCase() === EXPRESS_DELIVERY_CATEGORY;
}

/** Stores a deliberate, bounded delivery snapshot; fare authority remains separate. */
export function deliveryRideFields(delivery: DeliveryDetails | undefined) {
  if (!delivery) {
    return {
      delivery: null,
      delivery_sender_name: null,
      delivery_sender_phone: null,
      delivery_recipient_name: null,
      delivery_recipient_phone: null,
      delivery_package_description: null,
      delivery_pickup_instructions: null,
      delivery_dropoff_instructions: null,
    };
  }

  return {
    delivery: delivery,
    delivery_sender_name: delivery.sender.name,
    delivery_sender_phone: delivery.sender.phone,
    delivery_recipient_name: delivery.recipient.name,
    delivery_recipient_phone: delivery.recipient.phone,
    delivery_package_description: delivery.packageDescription,
    delivery_pickup_instructions: delivery.pickupInstructions || null,
    delivery_dropoff_instructions: delivery.dropoffInstructions || null,
  };
}
