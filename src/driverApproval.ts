import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { ADMIN_COLLECTIONS, adminFirestore, getAdminDb } from './firebaseAdmin';

export type DriverApprovalState = 'approved' | 'pending' | 'rejected';
export const DRIVER_PROFILE_AUTHORITY_CAP = 20;

function normalizedApprovalValue(value: unknown): DriverApprovalState | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'approved' || normalized === 'pending' || normalized === 'rejected' ? normalized : null;
}

/** Explicit application decisions always override historical boolean aliases. */
export function driverApprovalState(profile: Record<string, any> | null | undefined): DriverApprovalState {
  if (!profile) return 'pending';
  for (const value of [profile.approval_status, profile.application_status, profile.status]) {
    const state = normalizedApprovalValue(value);
    if (state) return state;
  }
  return profile.approved === true || profile.is_approved === true ? 'approved' : 'pending';
}

export function isApprovedDriverProfile(profile: Record<string, any> | null | undefined): profile is Record<string, any> {
  const accountStatus = String(profile?.account_status || 'active').trim().toLowerCase();
  const legacyLifecycle = String(profile?.status || '').trim().toLowerCase();
  return driverApprovalState(profile) === 'approved'
    && !['suspended', 'inactive', 'removed', 'disabled'].includes(accountStatus)
    && !['suspended', 'inactive', 'removed', 'disabled'].includes(legacyLifecycle);
}

export class DriverProfileAuthorityError extends Error {
  constructor(message = 'Driver profile ownership or application authority could not be confirmed. Please contact HY3N Support.') {
    super(message);
    this.name = 'DriverProfileAuthorityError';
  }
}

const applicationFields = [
  'user_id', 'full_name', 'name', 'email', 'phone', 'phone_number', 'mobile_number', 'momo_number', 'city',
  'service_type', 'accepted_categories', 'ride_categories', 'vehicle_make', 'vehicle_model',
  'vehicle_plate', 'license_plate', 'vehicle_color', 'vehicle_colour', 'vehicle_year',
  'ghana_card_front_url', 'ghana_card_back_url', 'drivers_license_front_url', 'drivers_license_back_url',
  'profile_photo_url', 'vehicle_photo_url', 'vehicle_registration_url', 'insurance_url', 'roadworthy_url',
  'approval_status', 'application_status', 'approved', 'is_approved', 'approval_updated_at', 'approval_updated_by',
  'rejection_reason', 'account_status', 'account_status_updated_at', 'account_status_updated_by', 'status', 'is_test_driver', 'application_submitted_at',
];

/** Stable application/decision comparison; heartbeats and preferences timestamps are not decisions. */
export function driverApplicationAuthorityFingerprint(profile: Record<string, any> | null): string {
  return JSON.stringify(applicationFields.map((field) => [field, profile?.[field] ?? null]));
}

/** Presence/preferences can create a UID stub. Neither such a stub nor its timestamp is an application. */
export function hasDriverApplicationAuthority(profile: Record<string, any> | null | undefined): boolean {
  if (!profile) return false;
  return [profile.approval_status, profile.application_status, profile.status].some((value) => normalizedApprovalValue(value) !== null)
    || typeof profile.approved === 'boolean' || typeof profile.is_approved === 'boolean'
    || Boolean(profile.approval_updated_at || profile.approval_updated_by || profile.application_submitted_at)
    || Boolean(profile.full_name || profile.name || profile.email || profile.registration_source)
    || applicationFields.some((field) => field.endsWith('_url') && Boolean(profile[field]));
}

/** Canonical application wins, including pending/rejected. Only a nonapplication UID stub may fall back. */
export function selectOwnedDriverProfile(uid: string, profiles: Array<Record<string, any> | null | undefined>): Record<string, any> | null {
  const candidates = profiles.filter((profile): profile is Record<string, any> => Boolean(profile));
  const canonical = candidates.find((profile) => String(profile.id || '') === uid);
  if (canonical && canonical.user_id && String(canonical.user_id).trim() !== uid) throw new DriverProfileAuthorityError();
  const owned = new Map<string, Record<string, any>>();
  for (const profile of candidates) {
    if (String(profile.user_id || '').trim() === uid || profile === canonical) owned.set(String(profile.id), profile);
  }
  if (owned.size > DRIVER_PROFILE_AUTHORITY_CAP) throw new DriverProfileAuthorityError('Too many linked Driver profiles to safely resolve. Please contact HY3N Support.');
  if (canonical && hasDriverApplicationAuthority(canonical)) return canonical;
  const legacy = [...owned.values()].filter((profile) => profile.id !== uid && hasDriverApplicationAuthority(profile))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  if (!legacy.length) return canonical || [...owned.values()][0] || null;
  if (legacy.some((profile) => driverApplicationAuthorityFingerprint(profile) !== driverApplicationAuthorityFingerprint(legacy[0]))) {
    throw new DriverProfileAuthorityError('Conflicting legacy Driver applications require manual reconciliation. Please contact HY3N Support.');
  }
  // A stub must never reactivate an inactive/suspended legacy application (or vice versa).
  const selected = legacy[0];
  if (canonical && ['suspended', 'inactive', 'removed', 'disabled'].includes(String(canonical.account_status || canonical.status || '').trim().toLowerCase())) {
    return { ...selected, account_status: canonical.account_status || canonical.status };
  }
  return selected;
}

/** Kept for existing callers: approval is never a sort preference. Pass UID for canonical authority. */
export function preferredDriverProfile(profiles: Array<Record<string, any> | null | undefined>, uid?: string): Record<string, any> | null {
  const candidates = profiles.filter((profile): profile is Record<string, any> => Boolean(profile));
  const owners = [...new Set(candidates.map((profile) => String(profile.user_id || '').trim()).filter(Boolean))];
  if (uid || owners.length === 1) return selectOwnedDriverProfile(uid || owners[0], candidates);
  return [...candidates].sort((left, right) => String(right.updated_date || right.created_date || '').localeCompare(
    String(left.updated_date || left.created_date || ''),
  ) || String(left.id || '').localeCompare(String(right.id || '')))[0] || null;
}

export interface DriverProfileAuthority {
  profile: Record<string, any> | null;
  profiles: Record<string, any>[];
  canonical: Record<string, any> | null;
}

/** All reads precede caller writes; use inside each Firestore retry for commit-time eligibility. */
export async function readDriverProfileAuthority(
  uid: string, transaction?: Transaction, db: Firestore = getAdminDb(),
): Promise<DriverProfileAuthority> {
  const collection = db.collection(ADMIN_COLLECTIONS.DRIVER_PROFILES);
  const canonicalRef = collection.doc(uid);
  const query = collection.where('user_id', '==', uid).orderBy('__name__').limit(DRIVER_PROFILE_AUTHORITY_CAP + 1);
  const canonicalSnapshot = transaction ? await transaction.get(canonicalRef) : await canonicalRef.get();
  const matches = transaction ? await transaction.get(query) : await query.get();
  const canonical = canonicalSnapshot.exists ? { ...canonicalSnapshot.data(), id: canonicalSnapshot.id } : null;
  const profiles = new Map<string, Record<string, any>>();
  for (const snapshot of matches.docs) profiles.set(snapshot.id, { ...snapshot.data(), id: snapshot.id });
  if (matches.docs.length > DRIVER_PROFILE_AUTHORITY_CAP) throw new DriverProfileAuthorityError('Too many linked Driver profiles to safely resolve.');
  if (canonical) profiles.set(uid, canonical);
  return { profile: selectOwnedDriverProfile(uid, [...profiles.values()]), profiles: [...profiles.values()], canonical };
}

export async function driverProfileForUserId(driverId: string): Promise<Record<string, any> | null> {
  const uidProfile = await adminFirestore.get(ADMIN_COLLECTIONS.DRIVER_PROFILES, driverId);
  // Explicit canonical decisions are authoritative, but ownership is still validated.
  if (uidProfile && hasDriverApplicationAuthority(uidProfile)) return selectOwnedDriverProfile(driverId, [{ ...uidProfile, id: driverId }]);
  const matches = await adminFirestore.list(ADMIN_COLLECTIONS.DRIVER_PROFILES, { user_id: driverId }, null, 'desc', DRIVER_PROFILE_AUTHORITY_CAP + 1);
  if (matches.length > DRIVER_PROFILE_AUTHORITY_CAP) throw new DriverProfileAuthorityError();
  return selectOwnedDriverProfile(driverId, [...matches, uidProfile ? { ...uidProfile, id: driverId } : null]);
}

export function approvalRequiredError(): Error {
  return new Error('Your Driver application must be approved by HY3N before you can go online or receive ride requests.');
}
