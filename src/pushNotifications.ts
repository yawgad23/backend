import { createHash } from 'node:crypto';
import { ADMIN_COLLECTIONS, adminFirestore } from './firebaseAdmin';

const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';
const EXPO_PUSH_TOKEN = /^(?:Expo|Exponent)PushToken\[[^\]]{8,260}\]$/;

export type PushRole = 'rider' | 'driver';

type PushDevice = Record<string, any> & {
  id: string;
  uid: string;
  role: PushRole;
  token: string;
  active?: boolean;
};

type ExpoTicket = {
  status?: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
};

function isoNow() {
  return new Date().toISOString();
}

function cleanText(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function compactMessage(value: unknown): string {
  const message = cleanText(value, 'New message');
  return message.length > 180 ? `${message.slice(0, 177)}…` : message;
}

function deviceId(role: PushRole, uid: string, token: string): string {
  const digest = createHash('sha256').update(token).digest('hex').slice(0, 40);
  return `${role}_${uid}_${digest}`;
}

export function isExpoPushToken(token: string): boolean {
  return EXPO_PUSH_TOKEN.test(token);
}

/**
 * Stores one app-install token under a server-only collection. A token is not
 * client-readable, so another account cannot use it to infer a recipient's
 * device information or send their own notifications.
 */
export async function registerPushDevice(input: {
  uid: string;
  role: PushRole;
  token: string;
  platform: 'ios' | 'android';
  appVersion?: string;
}) {
  if (!isExpoPushToken(input.token)) {
    throw new Error('That device did not provide a valid Expo push token.');
  }

  const id = deviceId(input.role, input.uid, input.token);
  await adminFirestore.set(ADMIN_COLLECTIONS.PUSH_DEVICES, id, {
    uid: input.uid,
    role: input.role,
    token: input.token,
    platform: input.platform,
    app_version: cleanText(input.appVersion || '', '').slice(0, 80) || null,
    active: true,
    registered_at: isoNow(),
    invalidated_at: null,
  });
  return { id };
}

async function retirePushDevice(device: PushDevice, reason: string) {
  await adminFirestore.set(ADMIN_COLLECTIONS.PUSH_DEVICES, device.id, {
    active: false,
    invalidated_at: isoNow(),
    invalid_reason: reason,
  });
}

async function pushDevicesForRecipient(uid: string, role: PushRole): Promise<PushDevice[]> {
  const devices = await adminFirestore.list(
    ADMIN_COLLECTIONS.PUSH_DEVICES,
    { uid },
    null,
    'desc',
  ) as PushDevice[];

  const unique = new Map<string, PushDevice>();
  for (const device of devices) {
    if (device.role === role && device.active === true && isExpoPushToken(String(device.token || ''))) {
      unique.set(device.token, device);
    }
  }
  return [...unique.values()];
}

async function recordDelivery(input: {
  messageId: string;
  rideId: string;
  recipientUid: string;
  recipientRole: PushRole;
  device: PushDevice;
  ticket?: ExpoTicket;
}) {
  await adminFirestore.create(ADMIN_COLLECTIONS.PUSH_DELIVERIES, {
    type: 'chat_message',
    message_id: input.messageId,
    ride_id: input.rideId,
    recipient_uid: input.recipientUid,
    recipient_role: input.recipientRole,
    device_id: input.device.id,
    expo_ticket_id: input.ticket?.id || null,
    provider_status: input.ticket?.status || 'error',
    provider_error: input.ticket?.details?.error || input.ticket?.message || null,
    sent_at: isoNow(),
  });
}

/**
 * Sends a private ride-chat notification only after a newly created message is
 * verified against the parent ride. The Firestore trigger, rather than either
 * mobile client, owns dispatch so pushes also work when a sender is offline.
 */
export async function sendRideChatPush(messageId: string, rawMessage: Record<string, any>) {
  const rideId = cleanText(rawMessage.ride_id, '');
  const senderId = cleanText(rawMessage.sender_id, '');
  const senderRole = cleanText(rawMessage.sender_role, '').toLowerCase();
  if (!rideId || !senderId || (senderRole !== 'rider' && senderRole !== 'driver')) {
    console.warn('[Push] Ignoring malformed ride message', { messageId, rideId, senderRole });
    return { attempted: 0, sent: 0 };
  }

  const ride = await adminFirestore.get(ADMIN_COLLECTIONS.RIDES, rideId);
  if (!ride) {
    console.warn('[Push] Ignoring chat message without parent ride', { messageId, rideId });
    return { attempted: 0, sent: 0 };
  }

  const riderId = cleanText(ride.rider_id || ride.riderId || ride.user_id, '');
  const driverId = cleanText(ride.driver_id || ride.driverId, '');
  const senderMatchesRide = senderRole === 'rider' ? senderId === riderId : senderId === driverId;
  if (!senderMatchesRide) {
    console.warn('[Push] Ignoring unauthorised ride message sender', { messageId, rideId, senderRole });
    return { attempted: 0, sent: 0 };
  }

  const recipientRole: PushRole = senderRole === 'rider' ? 'driver' : 'rider';
  const recipientUid = recipientRole === 'rider' ? riderId : driverId;
  if (!recipientUid) return { attempted: 0, sent: 0 };

  const devices = await pushDevicesForRecipient(recipientUid, recipientRole);
  if (devices.length === 0) return { attempted: 0, sent: 0 };

  const senderName = cleanText(rawMessage.sender_name, senderRole === 'rider' ? 'Rider' : 'Driver').slice(0, 80);
  const payload = devices.map((device) => ({
    to: device.token,
    title: `Message from ${senderName}`,
    body: compactMessage(rawMessage.message),
    sound: 'default',
    priority: 'high',
    channelId: 'rides',
    data: {
      type: 'chat_message',
      rideId,
      messageId,
      senderRole,
    },
  }));

  try {
    const response = await fetch(EXPO_PUSH_ENDPOINT, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({})) as { data?: ExpoTicket[]; errors?: unknown[] };
    if (!response.ok || !Array.isArray(result.data)) {
      console.error('[Push] Expo rejected chat notifications', { messageId, status: response.status, errors: result.errors || null });
      return { attempted: devices.length, sent: 0 };
    }

    let sent = 0;
    await Promise.all(result.data.map(async (ticket, index) => {
      const device = devices[index];
      if (!device) return;
      await recordDelivery({ messageId, rideId, recipientUid, recipientRole, device, ticket });
      if (ticket.status === 'ok') {
        sent += 1;
      } else if (ticket.details?.error === 'DeviceNotRegistered') {
        await retirePushDevice(device, 'DeviceNotRegistered');
      }
    }));
    console.info('[Push] Chat notification dispatch complete', { messageId, rideId, attempted: devices.length, sent });
    return { attempted: devices.length, sent };
  } catch (error) {
    console.error('[Push] Expo chat notification dispatch failed', { messageId, rideId, error });
    return { attempted: devices.length, sent: 0 };
  }
}
