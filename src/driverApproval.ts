import { adminFirestore, ADMIN_COLLECTIONS } from './firebaseAdmin';

export type DriverApprovalState = 'approved' | 'pending' | 'rejected';

function normalizedApprovalValue(value: unknown): DriverApprovalState | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'approved') return 'approved';
  if (normalized === 'pending') return 'pending';
  if (normalized === 'rejected') return 'rejected';
  return null;
}

/**
 * Reads the administrator-controlled approval fields consistently across legacy
 * and current driver-profile documents. Missing or unknown values are pending:
 * a Driver must be explicitly approved before becoming dispatchable.
 */
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
  return driverApprovalState(profile) === 'approved'
    && accountStatus !== 'suspended'
    && accountStatus !== 'inactive'
    && accountStatus !== 'removed';
}

export function preferredDriverProfile(profiles: Array<Record<string, any> | null | undefined>): Record<string, any> | null {
  const candidates = profiles.filter((profile): profile is Record<string, any> => Boolean(profile));
  if (!candidates.length) return null;
  return candidates.sort((left, right) => {
    const leftApproved = isApprovedDriverProfile(left);
    const rightApproved = isApprovedDriverProfile(right);
    if (leftApproved !== rightApproved) return leftApproved ? -1 : 1;
    return String(right.updated_date || right.created_date || '').localeCompare(
      String(left.updated_date || left.created_date || ''),
    );
  })[0];
}

/**
 * Profiles created by the legacy admin workflow can use an auto-generated ID,
 * while current mobile registration also maintains a UID-keyed document. Prefer
 * a currently approved document, then use the most recently changed record.
 */
export async function driverProfileForUserId(driverId: string): Promise<Record<string, any> | null> {
  // Current mobile clients maintain a UID-keyed compatibility document on every
  // presence update. Reading it first avoids a collection scan for each offer
  // poll, location heartbeat, and lifecycle tap. Legacy records still remain a
  // safe fallback whenever that document is absent or not approved.
  const uidProfile = await adminFirestore.get(ADMIN_COLLECTIONS.DRIVER_PROFILES, driverId);
  if (isApprovedDriverProfile(uidProfile)) return uidProfile;

  const matches = await adminFirestore.list(
    ADMIN_COLLECTIONS.DRIVER_PROFILES,
    { user_id: driverId },
    null,
  );
  return preferredDriverProfile([...matches, uidProfile]);
}

export function approvalRequiredError(): Error {
  return new Error('Your Driver application must be approved by HY3N before you can go online or receive ride requests.');
}
