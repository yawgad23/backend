import { createHash } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { ADMIN_COLLECTIONS, adminFirestore, getAdminDb } from './firebaseAdmin';

export type AccountRole = 'rider' | 'driver';
export type ContactKind = 'email' | 'phone';

export type AccountContacts = {
  email?: string | null;
  phone?: string | null;
};

export class AccountContactConflictError extends Error {
  readonly code = 'ACCOUNT_CONTACT_IN_USE';

  constructor() {
    // Keep this response useful without disclosing which contact or account owns it.
    super('This phone number or email is already attached to a HY3N account. Sign in to that account or use different contact details.');
  }
}

export class AccountContactCapacityError extends Error {
  readonly code = 'ACCOUNT_CONTACT_REVIEW_REQUIRED';

  constructor() {
    super('Account contact details need a safe support review. Please contact HY3N Support.');
  }
}

export function normalizeAccountEmail(value: unknown): string | null {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : null;
}

/** HY3N registration currently supports Ghana mobile numbers only. */
export function normalizeAccountPhone(value: unknown): string | null {
  const raw = String(value ?? '').trim().replace(/[^\d+]/g, '');
  const normalized = raw.startsWith('+233')
    ? raw
    : raw.startsWith('00233')
      ? `+${raw.slice(2)}`
      : raw.startsWith('233')
        ? `+${raw}`
        : raw.startsWith('0')
          ? `+233${raw.slice(1)}`
          : `+233${raw}`;
  return /^\+233\d{9}$/.test(normalized) ? normalized : null;
}

export function contactClaimDocumentId(role: AccountRole, kind: ContactKind, normalizedValue: string): string {
  // Rider and Driver are separate applications. The same verified contact may
  // own one Rider account and one Driver account, but may not duplicate an
  // account of the same role. v2 deliberately stops using legacy global IDs.
  return createHash('sha256').update(`hy3n-account-contact:v2:${role}:${kind}:${normalizedValue}`).digest('hex');
}

export function normalizedContactEntries(contacts: AccountContacts): Array<{ kind: ContactKind; value: string }> {
  const email = normalizeAccountEmail(contacts.email);
  const phone = normalizeAccountPhone(contacts.phone);
  return [
    ...(email ? [{ kind: 'email' as const, value: email }] : []),
    ...(phone ? [{ kind: 'phone' as const, value: phone }] : []),
  ];
}

export function profileContacts(profile: Record<string, unknown>): AccountContacts {
  const phoneValue = profile.phone ?? profile.phone_number ?? profile.mobile_number ?? null;
  return {
    email: typeof profile.email === 'string' ? profile.email : null,
    phone: typeof phoneValue === 'string' ? phoneValue : null,
  };
}

function profileUserId(profile: Record<string, unknown>): string | null {
  const value = String(profile.user_id || profile.id || '').trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
}

/** Maps a normalized contact to every existing profile UID that already uses it. */
export function legacyContactOwners(
  profiles: Array<Record<string, unknown>>,
): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>();
  for (const profile of profiles) {
    const ownerUid = profileUserId(profile);
    if (!ownerUid) continue;
    for (const entry of normalizedContactEntries(profileContacts(profile))) {
      const key = `${entry.kind}:${entry.value}`;
      const values = owners.get(key) || new Set<string>();
      values.add(ownerUid);
      owners.set(key, values);
    }
  }
  return owners;
}

function assertLegacyOwners(
  entries: Array<{ kind: ContactKind; value: string }>,
  ownerUid: string,
  legacyOwners: Map<string, Set<string>>,
  transferableOwnerUids: Set<string>,
) {
  for (const entry of entries) {
    const owners = legacyOwners.get(`${entry.kind}:${entry.value}`) || new Set<string>();
    const unrelatedOwners = [...owners].filter((uid) => uid !== ownerUid && !transferableOwnerUids.has(uid));
    if (unrelatedOwners.length > 0) throw new AccountContactConflictError();
  }
}

/**
 * Reserves opaque contact claim documents transactionally. The claims contain
 * hashes only; raw phone/email values stay on private account profile records.
 */
export async function claimAccountContacts(input: {
  ownerUid: string;
  role: AccountRole;
  contacts: AccountContacts;
  transferableOwnerUids?: Iterable<string>;
}) {
  const entries = normalizedContactEntries(input.contacts).map((entry) => ({
    ...entry,
    claimId: contactClaimDocumentId(input.role, entry.kind, entry.value),
  }));
  if (entries.length === 0) return;
  const transferableOwnerUids = new Set(input.transferableOwnerUids || []);
  const roleProfiles = await adminFirestore.listAll(
    input.role === 'rider' ? ADMIN_COLLECTIONS.RIDER_PROFILES : ADMIN_COLLECTIONS.DRIVER_PROFILES,
  );
  if (roleProfiles.truncated) throw new AccountContactCapacityError();

  const legacyOwners = legacyContactOwners(roleProfiles.records);
  assertLegacyOwners(entries, input.ownerUid, legacyOwners, transferableOwnerUids);

  const db: Firestore = getAdminDb();
  await db.runTransaction(async (transaction) => {
    const references = entries.map((entry) => db.collection(ADMIN_COLLECTIONS.ACCOUNT_CONTACT_CLAIMS).doc(entry.claimId));
    const snapshots = await Promise.all(references.map((reference) => transaction.get(reference)));
    const timestamp = new Date().toISOString();

    snapshots.forEach((snapshot, index) => {
      if (!snapshot.exists) return;
      const currentOwner = String(snapshot.get('owner_uid') || '').trim();
      if (currentOwner && currentOwner !== input.ownerUid && !transferableOwnerUids.has(currentOwner)) {
        throw new AccountContactConflictError();
      }
      const entry = entries[index];
      transaction.set(snapshot.ref, {
        owner_uid: input.ownerUid,
        role: input.role,
        contact_kind: entry.kind,
        contact_digest: entry.claimId,
        transferred_at: currentOwner && currentOwner !== input.ownerUid ? timestamp : null,
        updated_date: timestamp,
      }, { merge: true });
    });

    snapshots.forEach((snapshot, index) => {
      if (snapshot.exists) return;
      const entry = entries[index];
      transaction.create(snapshot.ref, {
        owner_uid: input.ownerUid,
        role: input.role,
        contact_kind: entry.kind,
        contact_digest: entry.claimId,
        created_date: timestamp,
        updated_date: timestamp,
      });
    });
  });
}
