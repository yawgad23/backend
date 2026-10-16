import { normalizeAccountEmail, normalizeAccountPhone, profileContacts } from './accountContactClaims';

export type RiderAccountRecovery = {
  legacyOwnerUid: string;
  profile: Record<string, any>;
};

type RecoveryInput = {
  currentUid: string;
  sessionEmail: string | null;
  sessionPhone: string | null;
  requestedEmail: string | null;
  requestedPhone: string | null;
  riderProfiles: Array<Record<string, any>>;
  driverProfiles: Array<Record<string, any>>;
};

function profileOwnerUid(profile: Record<string, any>): string | null {
  const value = String(profile.user_id || profile.id || '').trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
}

function profileTimestamp(profile: Record<string, any>): number {
  const value = profile.updated_date || profile.created_date || profile.account_created_at || '';
  const timestamp = new Date(String(value)).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isInactive(profile: Record<string, any>): boolean {
  return ['inactive', 'disabled', 'suspended', 'deleted', 'deactivated']
    .includes(String(profile.account_status || '').trim().toLowerCase());
}

/**
 * Selects a legacy Rider profile only when the new authenticated Firebase user
 * proves both contacts that are already stored on exactly one active Rider
 * profile. At least one matching contact must come from the authenticated
 * Firebase token (email-login or phone-login), so form fields alone can never
 * take over a legacy profile.
 */
export function selectVerifiedRiderAccountRecovery(input: RecoveryInput): RiderAccountRecovery | null {
  const sessionEmail = normalizeAccountEmail(input.sessionEmail);
  const sessionPhone = normalizeAccountPhone(input.sessionPhone);
  const requestedEmail = normalizeAccountEmail(input.requestedEmail);
  const requestedPhone = normalizeAccountPhone(input.requestedPhone);
  if (!requestedEmail || !requestedPhone) return null;
  const hasTokenVerifiedContact = (Boolean(sessionEmail) && sessionEmail === requestedEmail)
    || (Boolean(sessionPhone) && sessionPhone === requestedPhone);
  if (!hasTokenVerifiedContact) return null;

  const candidateByOwner = new Map<string, Record<string, any>>();
  for (const profile of input.riderProfiles) {
    const ownerUid = profileOwnerUid(profile);
    const contacts = profileContacts(profile);
    if (!ownerUid || ownerUid === input.currentUid || isInactive(profile)) continue;
    if (normalizeAccountEmail(contacts.email) !== requestedEmail || normalizeAccountPhone(contacts.phone) !== requestedPhone) continue;
    const previous = candidateByOwner.get(ownerUid);
    if (!previous || profileTimestamp(profile) > profileTimestamp(previous)) candidateByOwner.set(ownerUid, profile);
  }

  if (candidateByOwner.size !== 1) return null;
  const [legacyOwnerUid, profile] = [...candidateByOwner.entries()][0];

  // Both contacts must point only at the signed-in user or this exact legacy
  // profile across Rider and Driver data. Any third owner is a collision that
  // must stay blocked for support review rather than be transferred.
  const unrelatedOwners = new Set<string>();
  for (const record of [...input.riderProfiles, ...input.driverProfiles]) {
    const ownerUid = profileOwnerUid(record);
    if (!ownerUid || ownerUid === input.currentUid || ownerUid === legacyOwnerUid) continue;
    const contacts = profileContacts(record);
    const matchesEmail = normalizeAccountEmail(contacts.email) === requestedEmail;
    const matchesPhone = normalizeAccountPhone(contacts.phone) === requestedPhone;
    if (matchesEmail || matchesPhone) unrelatedOwners.add(ownerUid);
  }
  if (unrelatedOwners.size > 0) return null;

  return { legacyOwnerUid, profile };
}
