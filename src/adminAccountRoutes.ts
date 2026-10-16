import type { Express, Request, Response } from 'express';
import { ADMIN_COLLECTIONS, adminFirestore, getAdminAuth } from './firebaseAdmin';
import { requireAdministrator } from './adminAuthorization';
import { accountIsDisabled, accountStatusPatch, type AccountStatus } from './accountLifecycle';
import { buildDriverFeeBypass, revokeDriverFeeBypass, visibleDriverFeeBypass } from './driverFeeBypass';
import {
  AccountContactCapacityError,
  AccountContactConflictError,
  claimAccountContacts,
  normalizeAccountEmail,
  normalizeAccountPhone,
  normalizedContactEntries,
  profileContacts,
  releaseAccountContacts,
} from './accountContactClaims';
import { requiredAccountFullName } from './riderIdentity';

type AccountRole = 'rider' | 'driver';

export type AdminAccountIdentityCorrection = {
  role: AccountRole;
  fullName: string;
  email: string;
  phone: string;
  reason: string;
};

export type AdminAccountIdentityCorrectionResult =
  | { correction: AdminAccountIdentityCorrection; error: null }
  | { correction: null; error: string };

function role(value: unknown): AccountRole | null {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'rider' || normalized === 'driver' ? normalized : null;
}

/** Validates the narrow, auditable identity fields that an administrator may correct. */
export function adminAccountIdentityCorrectionInput(value: Record<string, unknown>): AdminAccountIdentityCorrectionResult {
  const accountRole = role(value.role);
  const fullName = requiredAccountFullName(value.fullName);
  const email = normalizeAccountEmail(value.email);
  const phone = normalizeAccountPhone(value.phone);
  const reason = cleanIdentityText(value.reason, 500);
  if (!accountRole) return { correction: null, error: 'Choose the Rider or Driver account to correct.' };
  if (!fullName) return { correction: null, error: 'Enter the account holder’s real full name.' };
  if (!email || !phone) return { correction: null, error: 'Enter a valid email address and Ghana mobile number.' };
  if (!reason || reason.length < 3) return { correction: null, error: 'Enter a short reason for this account correction.' };
  return { correction: { role: accountRole, fullName, email, phone, reason }, error: null };
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

function cleanIdentityText(value: unknown, maxLength: number): string | null {
  const normalized = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  return normalized ? normalized.slice(0, maxLength) : null;
}

function normalizedPhone(value: unknown): string | null {
  const digits = cleanIdentityText(value, 40)?.replace(/\D/g, '') || '';
  if (!digits) return null;
  if (/^0\d{9}$/.test(digits)) return `233${digits.slice(1)}`;
  return digits;
}

function normalizedEmail(value: unknown): string | null {
  return cleanIdentityText(value, 160)?.toLowerCase() || null;
}

function usableRiderName(value: unknown): string | null {
  const name = cleanIdentityText(value, 120);
  return name && !['rider', 'hy3n rider', 'unknown', 'unnamed account'].includes(name.toLowerCase()) ? name : null;
}

function usableDriverName(value: unknown): string | null {
  const name = cleanIdentityText(value, 120);
  return name && !['driver', 'hy3n driver', 'unknown', 'unnamed account'].includes(name.toLowerCase()) ? name : null;
}

/**
 * A historic Rider profile can be present but blank after a phone/third-party
 * sign-in created Firebase Auth without the profile form values. A trip is an
 * authenticated, server-owned snapshot for that same UID, so it can restore
 * only the empty identity fields. It never replaces an existing profile value.
 */
export function riderIdentityRecoveryPatch(profile: Record<string, any>, ride: Record<string, any>) {
  const patch: Record<string, string | boolean> = {};
  const profileName = usableRiderName(profile.full_name || profile.name || profile.display_name);
  const rideName = usableRiderName(ride.rider_name || (ride.rider as Record<string, unknown> | undefined)?.name);
  const profilePhone = cleanIdentityText(profile.phone || profile.phone_number, 40);
  const ridePhone = cleanIdentityText(ride.rider_phone, 40);
  const profileEmail = cleanIdentityText(profile.email, 160);
  const rideEmail = cleanIdentityText(ride.rider_email, 160);

  if (!profileName && rideName) patch.full_name = rideName;
  if (!profilePhone && ridePhone) patch.phone = ridePhone;
  if (!profileEmail && rideEmail) patch.email = rideEmail.toLowerCase();
  if (Object.keys(patch).length > 0) patch.identity_recovered_from_ride = true;
  return patch;
}

/** A legacy phone-auth profile may have a newer Firebase UID than its ride history. */
export function legacyRiderContactMatches(profile: Record<string, any>, ride: Record<string, any>) {
  const nestedRider = ride.rider && typeof ride.rider === 'object' ? ride.rider as Record<string, unknown> : null;
  const profilePhone = normalizedPhone(profile.phone || profile.phone_number);
  const ridePhone = normalizedPhone(ride.rider_phone || nestedRider?.phone);
  const profileEmail = normalizedEmail(profile.email);
  const rideEmail = normalizedEmail(ride.rider_email || nestedRider?.email);
  return Boolean((profilePhone && profilePhone === ridePhone) || (profileEmail && profileEmail === rideEmail));
}

export function riderIdFromRide(ride: Record<string, any>): string | null {
  const nestedRider = ride.rider && typeof ride.rider === 'object' ? ride.rider as Record<string, unknown> : null;
  return validUserId(ride.rider_id || ride.riderId || nestedRider?.user_id || nestedRider?.id);
}

export function riderProfileFromRide(ride: Record<string, any>, totalRides: number): Record<string, any> | null {
  const userId = riderIdFromRide(ride);
  if (!userId) return null;
  const nestedRider = ride.rider && typeof ride.rider === 'object' ? ride.rider as Record<string, unknown> : null;
  const fullName = usableRiderName(ride.rider_name || nestedRider?.name);
  const phone = cleanIdentityText(ride.rider_phone || nestedRider?.phone, 40);
  const email = normalizedEmail(ride.rider_email || nestedRider?.email);
  // Never manufacture a visible account from an anonymous or malformed trip.
  if (!fullName && !phone && !email) return null;
  return {
    id: userId,
    user_id: userId,
    full_name: fullName || '',
    phone: phone || '',
    email: email || '',
    total_rides: totalRides,
    rating: 5,
    account_status: 'active',
    registration_source: 'ride_history_reconciliation',
    identity_recovered_from_ride: true,
    account_created_at: ride.created_date || ride.created_at || new Date().toISOString(),
  };
}

export function reconcileRiderProfilesFromRides(
  profiles: Array<Record<string, any>>,
  rides: Array<Record<string, any>>,
) {
  const knownUserIds = new Set(profiles.map(profileUserId));
  const rideCounts = new Map<string, number>();
  for (const ride of rides) {
    const riderId = riderIdFromRide(ride);
    if (riderId) rideCounts.set(riderId, (rideCounts.get(riderId) || 0) + 1);
  }
  const missingProfiles: Array<Record<string, any>> = [];
  for (const ride of rides) {
    const riderId = riderIdFromRide(ride);
    if (!riderId || knownUserIds.has(riderId)) continue;
    const profile = riderProfileFromRide(ride, rideCounts.get(riderId) || 0);
    if (!profile) continue;
    knownUserIds.add(riderId);
    missingProfiles.push(profile);
  }
  return missingProfiles;
}

function uniqueProfilesByUserId(profiles: Array<Record<string, any>>) {
  const unique = new Map<string, Record<string, any>>();
  for (const profile of profiles) {
    const userId = validUserId(profileUserId(profile));
    if (!userId) continue;
    unique.set(userId, unique.has(userId) ? newest(unique.get(userId)!, profile) : profile);
  }
  return [...unique.values()];
}

function normalizedAccountStatus(value: unknown): AccountStatus {
  const status = accountStatus(value);
  return status || 'active';
}

function normalizedDriverType(profile: Record<string, any>) {
  const type = cleanIdentityText(profile.service_type || profile.serviceType, 40)?.toLowerCase();
  return type || 'car';
}

/**
 * Produces the admin-visible registered-account totals from complete server
 * collections. Rider profiles recovered from a valid ride are included once
 * by UID, so duplicate profile documents and repeat rides cannot inflate totals.
 */
export function accountRegistrationSummary(
  driverProfiles: Array<Record<string, any>>,
  riderProfiles: Array<Record<string, any>>,
  rides: Array<Record<string, any>>,
) {
  const uniqueDrivers = uniqueProfilesByUserId(driverProfiles);
  const recoveredRiders = reconcileRiderProfilesFromRides(riderProfiles, rides);
  const uniqueRiders = uniqueProfilesByUserId([...riderProfiles, ...recoveredRiders]);
  const driversByStatus = { active: 0, suspended: 0, inactive: 0 };
  const ridersByStatus = { active: 0, suspended: 0, inactive: 0 };
  const driversByApproval = { approved: 0, pending: 0, rejected: 0 };
  const driversByType: Record<string, number> = {};
  let onlineDrivers = 0;

  for (const driver of uniqueDrivers) {
    driversByStatus[normalizedAccountStatus(driver.account_status)] += 1;
    const approval = cleanIdentityText(driver.approval_status, 40)?.toLowerCase();
    if (approval === 'approved' || approval === 'rejected') driversByApproval[approval] += 1;
    else driversByApproval.pending += 1;
    const driverType = normalizedDriverType(driver);
    driversByType[driverType] = (driversByType[driverType] || 0) + 1;
    if (driver.is_online === true || driver.availability_status === 'online') onlineDrivers += 1;
  }

  for (const rider of uniqueRiders) ridersByStatus[normalizedAccountStatus(rider.account_status)] += 1;

  return {
    drivers: {
      totalRegistered: uniqueDrivers.length,
      online: onlineDrivers,
      byStatus: driversByStatus,
      byApproval: driversByApproval,
      byType: driversByType,
    },
    riders: {
      totalRegistered: uniqueRiders.length,
      byStatus: ridersByStatus,
      recoveredFromRideHistory: recoveredRiders.length,
    },
  };
}

/** See riderIdentityRecoveryPatch: this deliberately excludes approval and vehicle fields. */
export function driverIdentityRecoveryPatch(profile: Record<string, any>, ride: Record<string, any>) {
  const patch: Record<string, string | boolean> = {};
  const nestedDriver = ride.driver && typeof ride.driver === 'object' ? ride.driver as Record<string, unknown> : null;
  const profileName = usableDriverName(profile.full_name || profile.name || profile.display_name);
  const rideName = usableDriverName(ride.driver_name || nestedDriver?.name);
  const profilePhone = cleanIdentityText(profile.phone || profile.phone_number, 40);
  const ridePhone = cleanIdentityText(ride.driver_phone || nestedDriver?.phone, 40);
  const profileEmail = cleanIdentityText(profile.email, 160);
  const rideEmail = cleanIdentityText(ride.driver_email || nestedDriver?.email, 160);

  if (!profileName && rideName) patch.full_name = rideName;
  if (!profilePhone && ridePhone) patch.phone = ridePhone;
  if (!profileEmail && rideEmail) patch.email = rideEmail.toLowerCase();
  if (Object.keys(patch).length > 0) patch.identity_recovered_from_ride = true;
  return patch;
}

async function recoverRiderIdentity(
  profile: Record<string, any>,
  loadLegacyRiderRides: () => Promise<Array<Record<string, any>>>,
) {
  const userId = profileUserId(profile);
  if (!userId) return profile;

  const name = usableRiderName(profile.full_name || profile.name || profile.display_name);
  // Keep account-list reads bounded. This repair is specifically for the
  // visible “Unnamed account” issue; contact fields can be completed by the
  // Rider from their Account page without issuing one ride query per profile.
  if (name) return profile;

  const candidates = (await loadLegacyRiderRides()).filter((ride) => riderIdFromRide(ride) === userId);
  // Phone-auth can create a different Firebase UID from the earlier email UID.
  // Fall back only to an exact normalized phone/email match, only for a blank
  // account name, and only if the UID lookup did not find a real Rider name.
  if (!candidates.some((ride) => usableRiderName(ride.rider_name || (ride.rider as Record<string, unknown> | undefined)?.name))) {
    const legacyMatches = (await loadLegacyRiderRides()).filter((ride) => legacyRiderContactMatches(profile, ride));
    for (const legacyRide of legacyMatches) {
      if (!candidates.some((candidate) => candidate.id === legacyRide.id)) candidates.push(legacyRide);
    }
  }

  for (const ride of candidates) {
    const patch = riderIdentityRecoveryPatch(profile, ride);
    if (Object.keys(patch).length === 0) continue;
    const saved = await adminFirestore.update(ADMIN_COLLECTIONS.RIDER_PROFILES, String(profile.id), {
      user_id: userId,
      ...patch,
    });
    return { ...profile, ...saved };
  }
  return profile;
}

async function recoverDriverIdentity(profile: Record<string, any>) {
  const userId = profileUserId(profile);
  if (!userId || usableDriverName(profile.full_name || profile.name || profile.display_name)) return profile;

  const rides = await adminFirestore.list(ADMIN_COLLECTIONS.RIDES, { driver_id: userId }, 'created_date', 'desc', 25);
  for (const ride of rides) {
    const patch = driverIdentityRecoveryPatch(profile, ride);
    if (Object.keys(patch).length === 0) continue;
    // Identity recovery must never change verification, vehicle, availability,
    // fee-bypass, or location fields. Manual Driver approval remains mandatory.
    const saved = await adminFirestore.update(ADMIN_COLLECTIONS.DRIVER_PROFILES, String(profile.id), {
      user_id: userId,
      ...patch,
    });
    return { ...profile, ...saved };
  }
  return profile;
}

function profileActivityTime(profile: Record<string, any>): number {
  for (const field of ['created_date', 'account_created_at', 'updated_date']) {
    const timestamp = Date.parse(String(profile[field] || ''));
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

export function newest(first: Record<string, any>, second: Record<string, any>) {
  return profileActivityTime(second) > profileActivityTime(first) ? second : first;
}

/**
 * Some older Rider app builds created their own profile documents without a
 * `created_date`. Firestore omits those documents from an orderBy(created_date)
 * query, even though the profile and their rides exist. Sort after reading so
 * every valid account remains visible to the administrator.
 */
export function sortProfilesNewestFirst(profiles: Array<Record<string, any>>) {
  return [...profiles].sort((first, second) => profileActivityTime(second) - profileActivityTime(first));
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
    createdAt: profile.created_date || profile.account_created_at || profile.updated_date || null,
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

/** Returns only the fields that actually changed, never the previous values. */
export function correctedIdentityFields(
  profile: Record<string, unknown>,
  correction: Pick<AdminAccountIdentityCorrection, 'fullName' | 'email' | 'phone'>,
) {
  const currentName = requiredAccountFullName(profile.full_name ?? profile.name ?? profile.display_name) || '';
  const currentEmail = normalizeAccountEmail(profile.email) || '';
  const currentPhone = normalizeAccountPhone(profile.phone ?? profile.phone_number ?? profile.mobile_number) || '';
  return [
    ...(currentName !== correction.fullName ? ['full name'] : []),
    ...(currentEmail !== correction.email ? ['email'] : []),
    ...(currentPhone !== correction.phone ? ['phone'] : []),
  ];
}

async function correctAccountIdentity(
  correction: AdminAccountIdentityCorrection,
  userId: string,
  administrator: string,
) {
  const records = await profilesForUser(correction.role, userId);
  if (records.length === 0) throw new Error('Account profile was not found.');

  const current = records.reduce((latest, profile) => newest(latest, profile));
  const changedFields = correctedIdentityFields(current, correction);
  if (changedFields.length === 0) {
    throw new Error('No identity or contact value has changed.');
  }

  const priorEntries = records.flatMap((profile) => normalizedContactEntries(profileContacts(profile)));
  const currentEntries = new Set(normalizedContactEntries({ email: correction.email, phone: correction.phone })
    .map((entry) => `${entry.kind}:${entry.value}`));
  const obsoleteContacts = {
    email: priorEntries.find((entry) => entry.kind === 'email' && !currentEntries.has(`${entry.kind}:${entry.value}`))?.value || null,
    phone: priorEntries.find((entry) => entry.kind === 'phone' && !currentEntries.has(`${entry.kind}:${entry.value}`))?.value || null,
  };
  const now = new Date().toISOString();
  const patch = {
    user_id: userId,
    full_name: correction.fullName,
    email: correction.email,
    phone: correction.phone,
    identity_corrected_at: now,
    identity_corrected_by: administrator,
    contact_claimed_at: now,
  };

  // The claim occurs before profile writes, so a contact cannot race another
  // same-app account. Do not change Firebase Auth login identifiers here:
  // Rider and Driver can intentionally share a contact but Firebase Auth is
  // project-wide; this operation corrects the role-specific profile record.
  await claimAccountContacts({ ownerUid: userId, role: correction.role, contacts: correction });
  await Promise.all(records.map((profile) => adminFirestore.set(
    accountCollection(correction.role),
    String(profile.id),
    patch,
  )));
  await adminFirestore.set(accountCollection(correction.role), userId, patch);
  await releaseAccountContacts({ ownerUid: userId, role: correction.role, contacts: obsoleteContacts });
  await adminFirestore.create('account_lifecycle_events', {
    user_id: userId,
    account_role: correction.role,
    action: 'account_identity_corrected',
    actor_type: 'administrator',
    actor_id: administrator,
    correction_reason: correction.reason,
    corrected_fields: changedFields,
  });
  return normalizedProfile({ ...current, ...patch }, correction.role);
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
  app.get('/api/admin/account-summary', async (request: Request, response: Response) => {
    const adminEmail = await requireAdministrator(request, response);
    if (!adminEmail) return;

    try {
      const [driversResult, ridersResult, ridesResult] = await Promise.all([
        adminFirestore.listAll(ADMIN_COLLECTIONS.DRIVER_PROFILES),
        adminFirestore.listAll(ADMIN_COLLECTIONS.RIDER_PROFILES),
        adminFirestore.listAll(ADMIN_COLLECTIONS.RIDES),
      ]);
      const summary = accountRegistrationSummary(
        driversResult.records,
        ridersResult.records,
        ridesResult.records,
      );
      response.json({
        ...summary,
        generatedAt: new Date().toISOString(),
        complete: !driversResult.truncated && !ridersResult.truncated && !ridesResult.truncated,
      });
    } catch (error) {
      console.error('[Admin accounts] Failed to calculate registration summary:', error);
      response.status(503).json({ error: 'Registration totals are temporarily unavailable. Please refresh.' });
    }
  });

  app.get('/api/admin/accounts', async (request: Request, response: Response) => {
    const adminEmail = await requireAdministrator(request, response);
    if (!adminEmail) return;
    const accountRole = role(request.query.role);
    if (!accountRole) {
      response.status(400).json({ error: 'Choose Rider or Driver.' });
      return;
    }

    try {
      // Do not ask Firestore to order by `created_date`: documents created by
      // prior mobile releases may not have that field and Firestore excludes
      // missing-field documents from an ordered query. The in-memory sort above
      // keeps the normal newest-first presentation without hiding real Riders.
      const records = sortProfilesNewestFirst(await adminFirestore.list(accountCollection(accountRole), {}, null, 'desc', 500));
      const riderRides = accountRole === 'rider'
        ? await adminFirestore.list(ADMIN_COLLECTIONS.RIDES, {}, null, 'desc', 500)
        : [];
      if (accountRole === 'rider') {
        const missingProfiles = reconcileRiderProfilesFromRides(records, riderRides);
        if (missingProfiles.length > 0) {
          await Promise.all(missingProfiles.map((profile) => adminFirestore.set(
            ADMIN_COLLECTIONS.RIDER_PROFILES,
            String(profile.user_id),
            profile,
          )));
          records.push(...missingProfiles);
        }
      }
      const unique = new Map<string, Record<string, any>>();
      for (const record of records) {
        const userId = profileUserId(record);
        if (!userId) continue;
        unique.set(userId, unique.has(userId) ? newest(unique.get(userId)!, record) : record);
      }
      let legacyRiderRides: Promise<Array<Record<string, any>>> | null = null;
      const loadLegacyRiderRides = () => {
        legacyRiderRides ??= Promise.resolve(riderRides);
        return legacyRiderRides;
      };
      const profiles = (accountRole === 'rider' || accountRole === 'driver')
        ? await Promise.all([...unique.values()].map(async (profile) => {
            try {
              return accountRole === 'rider'
                ? await recoverRiderIdentity(profile, loadLegacyRiderRides)
                : await recoverDriverIdentity(profile);
            } catch (error) {
              // An account list must remain available if one historic ride is
              // malformed or an optional identity-repair write is unavailable.
              console.warn(`[Admin accounts] ${accountRole} identity recovery skipped:`, error);
              return profile;
            }
          }))
        : [...unique.values()];
      response.json({ accounts: profiles.map((record) => normalizedProfile(record, accountRole)) });
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

  /**
   * Admin-only correction for a genuine profile identity/contact mistake. This
   * deliberately excludes IDs, roles, wallet/payment data, trip history,
   * Driver verification, vehicle fields, and account-status controls.
   */
  app.patch('/api/admin/accounts/:userId/identity', async (request: Request, response: Response) => {
    const adminEmail = await requireAdministrator(request, response);
    if (!adminEmail) return;
    const userId = validUserId(request.params.userId);
    const parsed = adminAccountIdentityCorrectionInput(request.body || {});
    if (!userId || !parsed.correction) {
      response.status(400).json({ error: !userId ? 'A valid account is required.' : parsed.error });
      return;
    }

    try {
      const account = await correctAccountIdentity(parsed.correction, userId, adminEmail);
      response.json({ success: true, account });
    } catch (error: any) {
      if (error instanceof AccountContactConflictError) {
        response.status(409).json({ error: error.message, code: error.code });
        return;
      }
      if (error instanceof AccountContactCapacityError) {
        response.status(503).json({ error: error.message, code: error.code });
        return;
      }
      const message = error instanceof Error ? error.message : 'The account correction could not be saved.';
      response.status(message === 'Account profile was not found.' ? 404 : 400).json({ error: message });
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
          correctionReason: event.correction_reason || null,
          correctedFields: Array.isArray(event.corrected_fields)
            ? event.corrected_fields.filter((field: unknown) => typeof field === 'string').slice(0, 3)
            : [],
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
