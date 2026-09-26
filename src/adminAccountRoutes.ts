import type { Express, Request, Response } from 'express';
import { ADMIN_COLLECTIONS, adminFirestore, getAdminAuth } from './firebaseAdmin';
import { requireAdministrator } from './adminAuthorization';

type AccountRole = 'rider' | 'driver';

type AccountStatus = 'active' | 'suspended';

function role(value: unknown): AccountRole | null {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'rider' || normalized === 'driver' ? normalized : null;
}

function accountStatus(value: unknown): AccountStatus | null {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'active' || normalized === 'suspended' ? normalized : null;
}

function accountCollection(accountRole: AccountRole): string {
  return accountRole === 'driver' ? ADMIN_COLLECTIONS.DRIVER_PROFILES : ADMIN_COLLECTIONS.RIDER_PROFILES;
}

function validUserId(value: unknown): string | null {
  const id = String(value || '').trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
}

function profileUserId(profile: Record<string, any>): string {
  return String(profile.user_id || profile.id || '').trim();
}

function newest(first: Record<string, any>, second: Record<string, any>) {
  const firstDate = String(first.updated_date || first.created_date || '');
  const secondDate = String(second.updated_date || second.created_date || '');
  return secondDate > firstDate ? second : first;
}

function normalizedProfile(profile: Record<string, any>, accountRole: AccountRole) {
  const userId = profileUserId(profile);
  return {
    profileId: profile.id,
    userId,
    role: accountRole,
    fullName: profile.full_name || profile.name || 'Unnamed account',
    email: profile.email || '',
    phone: profile.phone || profile.phone_number || '',
    accountStatus: String(profile.account_status || 'active').toLowerCase() === 'suspended' ? 'suspended' : 'active',
    approvalStatus: accountRole === 'driver' ? String(profile.approval_status || 'pending').toLowerCase() : null,
    isOnline: accountRole === 'driver' && (profile.is_online === true || profile.availability_status === 'online'),
    serviceType: accountRole === 'driver' ? profile.service_type || profile.serviceType || 'car' : null,
    vehicle: accountRole === 'driver'
      ? [profile.vehicle_year, profile.vehicle_make, profile.vehicle_model].filter(Boolean).join(' ') || null
      : null,
    plate: accountRole === 'driver' ? profile.license_plate || profile.vehicle_plate || null : null,
    rating: Number(profile.rating || 0),
    totalRides: Number(profile.total_rides || profile.total_trips || 0),
    createdAt: profile.created_date || null,
    documents: accountRole === 'driver'
      ? {
          profilePhoto: profile.profile_photo_url || profile.photo_url || profile.avatar_url || null,
          ghanaCardFront: profile.ghana_card_front_url || profile.ghana_card_url || profile.id_card_url || null,
          ghanaCardBack: profile.ghana_card_back_url || null,
          driverLicenseFront: profile.drivers_license_front_url || profile.drivers_license_url || profile.license_photo_url || null,
          driverLicenseBack: profile.drivers_license_back_url || null,
          vehiclePhoto: profile.vehicle_photo_url || null,
          vehicleRegistration: profile.vehicle_registration_url || profile.vehicle_reg_url || null,
          insurance: profile.insurance_url || null,
          roadworthy: profile.roadworthy_url || null,
        }
      : null,
  };
}

async function profilesForUser(accountRole: AccountRole, userId: string) {
  const collection = accountCollection(accountRole);
  const matching = await adminFirestore.list(collection, { user_id: userId }, null, 'desc', 20);
  const canonical = await adminFirestore.get(collection, userId);
  const records = [...matching, canonical].filter((record): record is Record<string, any> => Boolean(record));
  const unique = new Map<string, Record<string, any>>();
  for (const record of records) unique.set(String(record.id), record);
  return [...unique.values()];
}

async function setAccountStatus(accountRole: AccountRole, userId: string, status: AccountStatus, changedBy: string) {
  const records = await profilesForUser(accountRole, userId);
  if (records.length === 0) throw new Error('Account profile was not found.');

  const patch: Record<string, any> = {
    account_status: status,
    account_status_updated_at: new Date().toISOString(),
    account_status_updated_by: changedBy,
  };
  if (accountRole === 'driver' && status === 'suspended') {
    patch.is_online = false;
    patch.is_available = false;
    patch.availability_status = 'offline';
  }

  try {
    await getAdminAuth().updateUser(userId, { disabled: status === 'suspended' });
    if (status === 'suspended') await getAdminAuth().revokeRefreshTokens(userId);
  } catch (error: any) {
    // Some historic profile documents predate Firebase Auth. They cannot sign
    // in anyway, so still retain the administrator's profile-level control.
    if (error?.code !== 'auth/user-not-found') throw error;
  }

  await Promise.all(records.map((record) => adminFirestore.set(
    accountCollection(accountRole),
    String(record.id),
    { user_id: userId, ...patch },
  )));
  return normalizedProfile({ ...newest(records[0], records[records.length - 1]), ...patch }, accountRole);
}

function accountCreateInput(input: Record<string, any>) {
  const accountRole = role(input.role);
  if (!accountRole) throw new Error('Choose Rider or Driver.');
  const email = String(input.email || '').trim().toLowerCase();
  const password = String(input.password || '');
  const fullName = String(input.fullName || '').trim();
  const phone = String(input.phone || '').trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('Enter a valid email address.');
  if (password.length < 10) throw new Error('Temporary password must contain at least 10 characters.');
  if (!fullName) throw new Error('Enter the account holder’s name.');
  if (!phone) throw new Error('Enter a contact number.');
  return { accountRole, email, password, fullName, phone };
}

/**
 * Admin-only account lifecycle controls. Account removal disables the Firebase
 * login and removes profile documents, while payment, ride, and commission
 * records remain in place for operational and financial audit history.
 */
export function registerAdminAccountRoutes(app: Express) {
  app.get('/api/admin/accounts', async (request: Request, response: Response) => {
    const adminEmail = await requireAdministrator(request, response);
    if (!adminEmail) return;
    const accountRole = role(request.query.role);
    if (!accountRole) {
      response.status(400).json({ error: 'Choose Rider or Driver.' });
      return;
    }

    try {
      const records = await adminFirestore.list(accountCollection(accountRole), {}, 'created_date', 'desc', 500);
      const unique = new Map<string, Record<string, any>>();
      for (const record of records) {
        const userId = profileUserId(record);
        if (!userId) continue;
        unique.set(userId, unique.has(userId) ? newest(unique.get(userId)!, record) : record);
      }
      response.json({ accounts: [...unique.values()].map((record) => normalizedProfile(record, accountRole)) });
    } catch (error) {
      console.error('[Admin accounts] Failed to list accounts:', error);
      response.status(503).json({ error: 'Accounts are temporarily unavailable. Please refresh.' });
    }
  });

  app.post('/api/admin/accounts', async (request: Request, response: Response) => {
    const adminEmail = await requireAdministrator(request, response);
    if (!adminEmail) return;

    try {
      const input = accountCreateInput(request.body || {});
      const createdUser = await getAdminAuth().createUser({
        email: input.email,
        password: input.password,
        displayName: input.fullName,
        disabled: false,
      });
      const profile: Record<string, any> = {
        user_id: createdUser.uid,
        full_name: input.fullName,
        email: input.email,
        phone: input.phone,
        account_status: 'active',
        account_created_by: adminEmail,
        account_created_at: new Date().toISOString(),
        registration_source: 'admin_dashboard',
      };
      if (input.accountRole === 'driver') {
        profile.approval_status = 'pending';
        profile.is_online = false;
        profile.is_available = false;
        profile.availability_status = 'offline';
        profile.service_type = String(request.body?.serviceType || 'car').trim().toLowerCase() || 'car';
        profile.vehicle_make = String(request.body?.vehicleMake || '').trim();
        profile.vehicle_model = String(request.body?.vehicleModel || '').trim();
        profile.license_plate = String(request.body?.licensePlate || '').trim();
      } else {
        profile.rating = 5;
        profile.saved_locations = [];
        await adminFirestore.set(ADMIN_COLLECTIONS.WALLET, createdUser.uid, {
          user_id: createdUser.uid,
          user_type: 'rider',
          balance: 0,
          total_topped_up: 0,
          total_spent: 0,
          total_earned: 0,
        });
      }
      await adminFirestore.set(accountCollection(input.accountRole), createdUser.uid, profile);
      response.status(201).json({ account: normalizedProfile({ id: createdUser.uid, ...profile }, input.accountRole) });
    } catch (error: any) {
      const message = error?.code === 'auth/email-already-exists'
        ? 'An account with that email already exists.'
        : error?.message || 'The account could not be created.';
      response.status(400).json({ error: message });
    }
  });

  app.patch('/api/admin/accounts/:userId/status', async (request: Request, response: Response) => {
    const adminEmail = await requireAdministrator(request, response);
    if (!adminEmail) return;
    const userId = validUserId(request.params.userId);
    const accountRole = role(request.body?.role);
    const status = accountStatus(request.body?.status);
    if (!userId || !accountRole || !status) {
      response.status(400).json({ error: 'A valid account and status are required.' });
      return;
    }

    try {
      const account = await setAccountStatus(accountRole, userId, status, adminEmail);
      response.json({ account });
    } catch (error: any) {
      response.status(404).json({ error: error?.message || 'Account profile was not found.' });
    }
  });

  app.patch('/api/admin/drivers/:userId/approval', async (request: Request, response: Response) => {
    const adminEmail = await requireAdministrator(request, response);
    if (!adminEmail) return;
    const userId = validUserId(request.params.userId);
    const approvalStatus = String(request.body?.approvalStatus || '').trim().toLowerCase();
    if (!userId || !['approved', 'rejected', 'pending'].includes(approvalStatus)) {
      response.status(400).json({ error: 'Choose approved, rejected, or pending.' });
      return;
    }

    try {
      const profiles = await profilesForUser('driver', userId);
      if (profiles.length === 0) {
        response.status(404).json({ error: 'Driver profile was not found.' });
        return;
      }
      const patch: Record<string, any> = {
        approval_status: approvalStatus,
        approved: approvalStatus === 'approved',
        approval_updated_at: new Date().toISOString(),
        approval_updated_by: adminEmail,
        rejection_reason: approvalStatus === 'rejected' ? String(request.body?.reason || 'Application was not approved.').slice(0, 500) : null,
      };
      if (approvalStatus !== 'approved') {
        patch.is_online = false;
        patch.is_available = false;
        patch.availability_status = 'offline';
      }
      await Promise.all(profiles.map((profile) => adminFirestore.set(
        ADMIN_COLLECTIONS.DRIVER_PROFILES,
        String(profile.id),
        { user_id: userId, ...patch },
      )));
      response.json({ account: normalizedProfile({ ...newest(profiles[0], profiles[profiles.length - 1]), ...patch }, 'driver') });
    } catch (error) {
      console.error('[Admin accounts] Failed to update Driver approval:', error);
      response.status(503).json({ error: 'Driver approval could not be updated.' });
    }
  });

  app.delete('/api/admin/accounts/:userId', async (request: Request, response: Response) => {
    const adminEmail = await requireAdministrator(request, response);
    if (!adminEmail) return;
    const userId = validUserId(request.params.userId);
    const accountRole = role(request.query.role);
    if (!userId || !accountRole) {
      response.status(400).json({ error: 'A valid Rider or Driver account is required.' });
      return;
    }
    if (userId === (await getAdminAuth().verifyIdToken(String(request.headers.authorization || '').replace(/^Bearer\s+/i, ''))).uid) {
      response.status(400).json({ error: 'You cannot remove your own administrator account.' });
      return;
    }

    try {
      const profiles = await profilesForUser(accountRole, userId);
      await Promise.all(profiles.map((profile) => adminFirestore.delete(accountCollection(accountRole), String(profile.id))));
      try {
        await getAdminAuth().deleteUser(userId);
      } catch (error: any) {
        if (error?.code !== 'auth/user-not-found') throw error;
      }
      response.json({ success: true, removedUserId: userId, role: accountRole });
    } catch (error) {
      console.error('[Admin accounts] Failed to remove account:', error);
      response.status(503).json({ error: 'The account could not be removed. No financial or trip records were deleted.' });
    }
  });
}
