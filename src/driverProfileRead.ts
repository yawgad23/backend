import { ADMIN_COLLECTIONS, adminFirestore } from './firebaseAdmin';

function updatedAt(profile: Record<string, any>): string {
  return String(profile.updated_date || profile.created_date || '');
}

export function selectAuthenticatedDriverProfile(uid: string, profiles: Array<Record<string, any> | null | undefined>): Record<string, any> | null {
  const candidates = profiles
    .filter((profile): profile is Record<string, any> => Boolean(profile))
    .filter((profile) => String(profile.user_id || profile.id || '').trim() === uid);

  if (!candidates.length) return null;
  return [...candidates].sort((left, right) => updatedAt(right).localeCompare(updatedAt(left)))[0];
}

/**
 * Returns only a profile already owned by the authenticated Firebase UID.
 * This server-side fallback prevents a temporary Firestore client-read failure
 * from presenting an existing Driver as unregistered.
 */
export async function driverProfileForAuthenticatedUser(uid: string): Promise<Record<string, any> | null> {
  const [canonical, linkedProfiles] = await Promise.all([
    adminFirestore.get(ADMIN_COLLECTIONS.DRIVER_PROFILES, uid),
    adminFirestore.list(ADMIN_COLLECTIONS.DRIVER_PROFILES, { user_id: uid }, null, 'desc', 20),
  ]);

  return selectAuthenticatedDriverProfile(uid, [canonical, ...linkedProfiles]);
}
