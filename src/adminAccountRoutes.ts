import type { Express, Request, Response } from 'express';
import { ADMIN_COLLECTIONS, adminFirestore, getAdminAuth } from './firebaseAdmin';
import { requireAdministrator } from './adminAuthorization';
import { accountIsDisabled, accountStatusPatch, type AccountStatus } from './accountLifecycle';
import { buildDriverFeeBypass, revokeDriverFeeBypass, visibleDriverFeeBypass } from './driverFeeBypass';

type AccountRole = 'rider' | 'driver';

function role(value: unknown): AccountRole | null {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'rider' || normalized === 'driver' ? normalized : null;
}

function accountStatus(value: unknown): AccountStatus | null {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'active' || normalized === 'suspended' || normalized === 'inactive' ? normalized : null;
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
    accountStatus: ['suspended', 'inactive'].includes(String(profile.account_status || 'active').toLowerCase())
      ? String(profile.account_status).toLowerCase()
      : 'active',
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
    retentionAudit: {
      deletionRequested: profile.account_deletion_requested === true,
      inactivatedAt: profile.account_inactivated_at || null,
      inactivatedBy: profile.account_inactivated_by || null,
      retentionReviewAfter: profile.account_retention_review_after || null,
      accountStatusUpdatedAt: profile.account_status_updated_at || null,
      accountStatusUpdatedBy: profile.account_status_updated_by || null,
      reactivatedAt: profile.account_reactivated_at || null,
      reactivatedBy: profile.account_reactivated_by || null,
    },
    driverFeeBypass: accountRole === 'driver'
      ? visibleDriverFeeBypass(profile, new Date().toISOString().slice(0, 10))
      : null,
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

  const patch: Record<string, any> = accountStatusPatch(status, changedBy);
  if (accountRole === 'driver' && accountIsDisabled(status)) {
    patch.is_online = false;
    patch.is_available = false;
    patch.availability_status = 'offline';
  }

  try {
    await getAdminAuth().updateUser(userId, { disabled: accountIsDisabled(status) });
    if (accountIsDisabled(status)) await getAdminAuth().revokeRefreshTokens(userId);
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
  await adminFirestore.create('account_lifecycle_events', {
    user_id: userId,
    account_role: accountRole,
    action: status === 'inactive' ? 'account_deactivated' : status === 'suspended' ? 'account_suspended' : 'account_reactivated',
    actor_type: 'administrator',
    actor_id: changedBy,
    retained: status === 'inactive',
    retention_review_after: patch.account_retention_review_after || null,
  });
  if (accountRole === 'driver' && accountIsDisabled(status)) {
    await adminFirestore.set('driver_presence', userId, {
      user_id: userId,
      account_status: status,
      is_online: false,
      is_available: false,
      availability_status: 'offline',
      offline_reason: status === 'inactive' ? 'account_deactivated' : 'account_suspended',
    });
  }
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
 * Admin-only account lifecycle controls. Deactivation disables login while
 * retaining profile, ride, payment, commission, and safety records for review.
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

  app.get('/api/admin/accounts/:userId/lifecycle', async (request: Request, response: Response) => {
    const adminEmail = await requireAdministrator(request, response);
    if (!adminEmail) return;
    const userId = validUserId(request.params.userId);
    const accountRole = role(request.query.role);
    if (!userId || !accountRole) {
      response.status(400).json({ error: 'A valid account and role are required.' });
      return;
    }

    try {
      const events = await adminFirestore.list('account_lifecycle_events', {
        user_id: userId,
        account_role: accountRole,
      }, 'created_date', 'desc', 100);
      response.json({
        events: events.map((event) => ({
          id: event.id,
          action: String(event.action || 'account_status_updated'),
          actorType: String(event.actor_type || 'system'),
          actorId: String(event.actor_id || ''),
          retained: event.retained === true,
          retentionReviewAfter: event.retention_review_after || null,
          createdAt: event.created_date || null,
        })),
      });
    } catch (error) {
      console.error('[Admin accounts] Failed to load account lifecycle:', error);
      response.status(503).json({ error: 'Account audit records are temporarily unavailable. Please refresh.' });
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

  /**
   * A narrow, auditable fee-gate waiver for supervised operations. It does not
   * create a paid commission, alter the configured GH₵ fee, or bypass Hubtel
   * confirmation for a real collection; it only permits this approved Driver
   * to pass today's gate while the waiver is active.
   */
  app.patch('/api/admin/drivers/:userId/fee-bypass', async (request: Request, response: Response) => {
    const adminEmail = await requireAdministrator(request, response);
    if (!adminEmail) return;
    const userId = validUserId(request.params.userId);
    if (!userId) {
      response.status(400).json({ error: 'Invalid Driver account.' });
      return;
    }

    const enabled = request.body?.enabled === true;
    const reason = String(request.body?.reason || '').trim();
    if (enabled && !reason) {
      response.status(400).json({ error: 'Enter a reason for the temporary Driver fee bypass.' });
      return;
    }
    if (reason.length > 500) {
      response.status(400).json({ error: 'The bypass reason must be 500 characters or fewer.' });
      return;
    }

    try {
      const profiles = await profilesForUser('driver', userId);
      if (!profiles.length) {
        response.status(404).json({ error: 'Driver account was not found.' });
        return;
      }
      const now = new Date().toISOString();
      const date = now.slice(0, 10);
      const current = visibleDriverFeeBypass(profiles[0], date);
      const bypass = enabled
        ? buildDriverFeeBypass(date, reason, adminEmail, now)
        : revokeDriverFeeBypass(current, adminEmail, now);
      await Promise.all(profiles.map((profile) => adminFirestore.set(
        ADMIN_COLLECTIONS.DRIVER_PROFILES,
        String(profile.id),
        { user_id: userId, driver_fee_bypass: bypass },
      )));
      // The Driver fee gate reads the UID-keyed canonical profile. Keep it in
      // sync with any retained legacy profile documents above.
      await adminFirestore.set(ADMIN_COLLECTIONS.DRIVER_PROFILES, userId, {
        user_id: userId,
        driver_fee_bypass: bypass,
      });
      await adminFirestore.create('account_lifecycle_events', {
        user_id: userId,
        account_role: 'driver',
        action: enabled ? 'driver_fee_bypass_granted' : 'driver_fee_bypass_revoked',
        actor_type: 'administrator',
        actor_id: adminEmail,
        fee_bypass_date: date,
        fee_bypass_reason: enabled ? bypass.reason : null,
      });
      response.json({
        success: true,
        bypass: enabled ? bypass : null,
        account: normalizedProfile({ ...newest(profiles[0], profiles[profiles.length - 1]), driver_fee_bypass: bypass }, 'driver'),
      });
    } catch (error) {
      console.error('[Admin Driver fee bypass] Failed to update fee gate bypass:', error);
      response.status(503).json({ error: 'The Driver fee bypass could not be updated. Please try again.' });
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
      const account = await setAccountStatus(accountRole, userId, 'inactive', adminEmail);
      response.json({ success: true, account, role: accountRole, retained: true });
    } catch (error) {
      console.error('[Admin accounts] Failed to deactivate account:', error);
      response.status(503).json({ error: 'The account could not be deactivated. No records were removed.' });
    }
  });
}
