import { getMessaging } from 'firebase-admin/messaging';
import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import { requireAdministrator } from './adminAuthorization';
import { ADMIN_COLLECTIONS, adminFirestore } from './firebaseAdmin';

const NOTIFICATION_COLLECTION = 'push_notifications';
const MAX_FCM_BATCH_SIZE = 500;

const notificationInput = z.object({
  title: z.string().trim().min(1).max(65),
  body: z.string().trim().min(1).max(200),
  type: z.enum(['promo', 'price_drop', 'surge_warning', 'general']).default('general'),
});

export type AdminNotificationInput = z.infer<typeof notificationInput>;

function cleanToken(value: unknown): string | null {
  const token = typeof value === 'string' ? value.trim() : '';
  return token.length >= 20 && token.length <= 4096 ? token : null;
}

export function parseAdminNotificationInput(input: unknown): AdminNotificationInput {
  return notificationInput.parse(input);
}

export function fcmTokensFromRiderProfiles(profiles: Array<Record<string, unknown>>): string[] {
  const tokens = new Set<string>();
  for (const profile of profiles) {
    const token = cleanToken(profile.fcm_token);
    if (token) tokens.add(token);
  }
  return [...tokens];
}

function batches<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

async function notificationOverview() {
  const [riders, notifications] = await Promise.all([
    adminFirestore.list(ADMIN_COLLECTIONS.RIDER_PROFILES, {}, null, 'desc', 5_000),
    adminFirestore.list(NOTIFICATION_COLLECTION, {}, 'created_date', 'desc', 20),
  ]);
  return {
    enabledRiderCount: fcmTokensFromRiderProfiles(riders).length,
    notifications,
  };
}

async function broadcastToRiders(input: AdminNotificationInput, administrator: string) {
  const riders = await adminFirestore.list(ADMIN_COLLECTIONS.RIDER_PROFILES, {}, null, 'desc', 5_000);
  const tokens = fcmTokensFromRiderProfiles(riders);

  if (tokens.length === 0) {
    return { totalRecipients: 0, sentCount: 0, failedCount: 0, history: null };
  }

  let sentCount = 0;
  let failedCount = 0;
  try {
    for (const tokenBatch of batches(tokens, MAX_FCM_BATCH_SIZE)) {
      const result = await getMessaging().sendEachForMulticast({
        tokens: tokenBatch,
        notification: { title: input.title, body: input.body },
        data: { type: input.type },
        android: {
          priority: 'high',
          notification: { sound: 'default', channelId: 'general' },
        },
        apns: { payload: { aps: { sound: 'default' } } },
        webpush: {
          notification: { title: input.title, body: input.body, icon: '/icon-192.png', badge: '/icon-192.png' },
          fcmOptions: { link: 'https://ridehy3n.com' },
        },
      });
      sentCount += result.successCount;
      failedCount += result.failureCount;
    }
  } catch (error) {
    console.error('[Admin notifications] FCM broadcast failed', { administrator, error });
    throw new Error('The notification service is temporarily unavailable. Please try again.');
  }

  const history = await adminFirestore.create(NOTIFICATION_COLLECTION, {
    title: input.title,
    body: input.body,
    type: input.type,
    status: failedCount === 0 ? 'sent' : 'sent_with_failures',
    target: 'all_riders',
    total_recipients: tokens.length,
    sent_count: sentCount,
    failed_count: failedCount,
    sent_by: administrator,
  });
  return { totalRecipients: tokens.length, sentCount, failedCount, history };
}

/**
 * Administrative broadcast endpoints. The browser can request a broadcast but
 * never receives FCM tokens or a Firebase service-account credential.
 */
export function registerAdminNotificationRoutes(app: Express) {
  app.get('/api/admin/notifications', async (request: Request, response: Response) => {
    const administrator = await requireAdministrator(request, response);
    if (!administrator) return;
    try {
      response.json(await notificationOverview());
    } catch (error) {
      console.error('[Admin notifications] Failed to load overview', { administrator, error });
      response.status(503).json({ error: 'Notifications are temporarily unavailable. Please refresh.' });
    }
  });

  app.post('/api/admin/notifications/broadcast', async (request: Request, response: Response) => {
    const administrator = await requireAdministrator(request, response);
    if (!administrator) return;

    const parsed = notificationInput.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: 'Enter a title of up to 65 characters and a message of up to 200 characters.' });
      return;
    }

    try {
      const result = await broadcastToRiders(parsed.data, administrator);
      response.json(result);
    } catch (error: any) {
      response.status(503).json({ error: error?.message || 'Notifications could not be sent right now. Please try again.' });
    }
  });
}
