import { ADMIN_COLLECTIONS, adminFirestore } from './firebaseAdmin';
import { DRIVER_PROFILE_AUTHORITY_CAP, DriverProfileAuthorityError, selectOwnedDriverProfile } from './driverApproval';

export function selectAuthenticatedDriverProfile(uid: string, profiles: Array<Record<string, any> | null | undefined>): Record<string, any> | null {
  return selectOwnedDriverProfile(uid, profiles);
}

/** Token-owned canonical applications and operational checks use the same authority. */
export async function driverProfileForAuthenticatedUser(uid: string): Promise<Record<string, any> | null> {
  const [canonical, linkedProfiles] = await Promise.all([
    adminFirestore.get(ADMIN_COLLECTIONS.DRIVER_PROFILES, uid),
    adminFirestore.list(ADMIN_COLLECTIONS.DRIVER_PROFILES, { user_id: uid }, null, 'desc', DRIVER_PROFILE_AUTHORITY_CAP + 1),
  ]);
  if (linkedProfiles.length > DRIVER_PROFILE_AUTHORITY_CAP) throw new DriverProfileAuthorityError();
  return selectAuthenticatedDriverProfile(uid, [canonical ? { ...canonical, id: uid } : null, ...linkedProfiles.filter((profile) => profile.id !== uid)]);
}
