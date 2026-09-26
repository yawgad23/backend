import type { Express, Request, Response } from 'express';
import { adminFirestore } from './firebaseAdmin';
import { requireAdministrator } from './adminAuthorization';
import {
  getDailyPlatformFee,
  normalizeDriverServiceType,
  setDailyPlatformFee,
  type DriverServiceType,
} from './platformFee';

const OWNER_EMAIL = 'yawgad23@gmail.com';
const ACCESS_COLLECTION = 'admin_access';
const SERVICE_TYPES: DriverServiceType[] = ['car', 'okada', 'delivery'];

function isOwner(email: string) {
  return email.trim().toLowerCase() === OWNER_EMAIL;
}

function cleanEmail(value: unknown) {
  const email = String(value || '').trim().toLowerCase();
  return /^\S+@\S+\.\S+$/.test(email) ? email : '';
}

function accessRecord(record: Record<string, any>) {
  return {
    id: String(record.id || record.email || ''),
    email: String(record.email || record.id || '').trim().toLowerCase(),
    name: String(record.name || record.full_name || '').trim(),
    role: 'admin',
    isActive: record.is_active !== false,
    createdAt: record.created_date || null,
    updatedAt: record.updated_date || null,
  };
}

async function ownerOnly(request: Request, response: Response) {
  const adminEmail = await requireAdministrator(request, response);
  if (!adminEmail) return null;
  if (!isOwner(adminEmail)) {
    response.status(403).json({ error: 'Only the HY3N account owner can manage administrator access.' });
    return null;
  }
  return adminEmail;
}

/**
 * Settings and access controls for the dedicated admin dashboard. Every route
 * verifies a Firebase ID token on the server; no PIN, email allow-list, or
 * setting value is trusted from the browser.
 */
export function registerAdminSettingsRoutes(app: Express) {
  app.get('/api/admin/settings', async (request: Request, response: Response) => {
    const adminEmail = await requireAdministrator(request, response);
    if (!adminEmail) return;

    try {
      const fees = await Promise.all(SERVICE_TYPES.map((serviceType) => getDailyPlatformFee(serviceType)));
      response.json({
        administrator: { email: adminEmail, canManageAccess: isOwner(adminEmail) },
        platformFees: fees,
      });
    } catch (error) {
      console.error('[Admin settings] Failed to load settings:', error);
      response.status(503).json({ error: 'Settings are temporarily unavailable. Please refresh.' });
    }
  });

  app.put('/api/admin/settings/platform-fees/:serviceType', async (request: Request, response: Response) => {
    const adminEmail = await requireAdministrator(request, response);
    if (!adminEmail) return;
    const serviceType = normalizeDriverServiceType(request.params.serviceType);
    const amount = Number(request.body?.amount);

    try {
      const fee = await setDailyPlatformFee(serviceType, amount, adminEmail);
      response.json({ fee });
    } catch (error: any) {
      response.status(400).json({ error: error?.message || 'Enter a valid daily platform fee.' });
    }
  });

  app.get('/api/admin/access', async (request: Request, response: Response) => {
    const adminEmail = await ownerOnly(request, response);
    if (!adminEmail) return;

    try {
      const all = await adminFirestore.list(ACCESS_COLLECTION, {}, 'created_date', 'desc', 200);
      const byEmail = new Map<string, ReturnType<typeof accessRecord>>();
      for (const record of all) {
        const normalized = accessRecord(record);
        if (!normalized.email) continue;
        const current = byEmail.get(normalized.email);
        if (!current || normalized.id === normalized.email) byEmail.set(normalized.email, normalized);
      }
      byEmail.set(OWNER_EMAIL, {
        id: OWNER_EMAIL,
        email: OWNER_EMAIL,
        name: 'HY3N account owner',
        role: 'owner',
        isActive: true,
        createdAt: null,
        updatedAt: null,
      });
      response.json({ administrators: [...byEmail.values()].sort((a, b) => a.email.localeCompare(b.email)) });
    } catch (error) {
      console.error('[Admin settings] Failed to list administrator access:', error);
      response.status(503).json({ error: 'Administrator records are temporarily unavailable.' });
    }
  });

  app.put('/api/admin/access/:email', async (request: Request, response: Response) => {
    const adminEmail = await ownerOnly(request, response);
    if (!adminEmail) return;
    const email = cleanEmail(request.params.email);
    const name = String(request.body?.name || '').trim().slice(0, 120);
    const isActive = request.body?.isActive !== false;
    if (!email) {
      response.status(400).json({ error: 'Enter a valid administrator email address.' });
      return;
    }
    if (email === OWNER_EMAIL && !isActive) {
      response.status(400).json({ error: 'The HY3N account owner cannot be revoked.' });
      return;
    }

    try {
      const access = await adminFirestore.set(ACCESS_COLLECTION, email, {
        email,
        name: name || null,
        role: 'admin',
        is_active: isActive,
        updated_by: adminEmail,
      });
      response.json({ administrator: accessRecord(access) });
    } catch (error) {
      console.error('[Admin settings] Failed to update administrator access:', error);
      response.status(503).json({ error: 'Administrator access could not be updated.' });
    }
  });
}
