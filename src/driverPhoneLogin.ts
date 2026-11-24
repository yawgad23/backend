import type { Express, Request, Response } from 'express';
import { ADMIN_COLLECTIONS, adminFirestore, getAdminAuth, getAdminDb } from './firebaseAdmin';
import { AccountContactConflictError, claimAccountContacts } from './accountContactClaims';
import { driverProfileForAuthenticatedUser } from './driverProfileRead';
import { DRIVER_PROFILE_AUTHORITY_CAP, driverApplicationAuthorityFingerprint, driverApprovalState, hasDriverApplicationAuthority,
  isApprovedDriverProfile, readDriverProfileAuthority, DriverProfileAuthorityError, type DriverProfileAuthority } from './driverApproval';

/** Normalize Ghana mobile input to the Firebase/Firestore E.164 representation. */
export function normalizeGhanaPhone(value: unknown): string | null {
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

/** Legacy profiles can contain the same Ghana number in several safe formats. */
export function phoneLookupValues(phone: string): string[] {
  const normalized = normalizeGhanaPhone(phone);
  if (!normalized) return [];
  const national = normalized.slice(4);
  return [...new Set([normalized, `0${national}`, normalized.slice(1), national])];
}

export function profileMatchesVerifiedPhone(profile: Record<string, unknown>, verifiedPhone: string): boolean {
  const target = normalizeGhanaPhone(verifiedPhone);
  if (!target) return false;
  return ['phone', 'phone_number', 'mobile_number'].some((field) => (
    normalizeGhanaPhone(profile[field]) === target
  ));
}

function fingerprint(authority: DriverProfileAuthority): string {
  return JSON.stringify(authority.profiles.map((profile) => [profile.id, driverApplicationAuthorityFingerprint(profile)])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
}

async function authenticatedPhoneSession(request: Request, response: Response) {
  const authorization = String(request.headers.authorization || '');
  const idToken = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!idToken) {
    response.status(401).json({ success: false, message: 'Please verify your phone number and sign in again.' });
    return null;
  }

  try {
    const decoded = await getAdminAuth().verifyIdToken(idToken, true);
    const phone = normalizeGhanaPhone(decoded.phone_number);
    if (!phone) {
      response.status(403).json({ success: false, message: 'This login is not verified by phone. Please request a new verification code.' });
      return null;
    }
    return { uid: decoded.uid, phone };
  } catch {
    response.status(401).json({ success: false, message: 'Your phone-login session has expired. Please try again.' });
    return null;
  }
}

/**
 * Binds a Firebase phone-auth session to the pre-existing Driver application
 * that has the same verified registration phone. This is intentionally
 * server-side: the app never chooses a profile ID or rewrites approval state.
 */
export function registerDriverPhoneLoginRoutes(app: Express) {
  app.get('/api/driver/profile/current', async (request, response) => {
    const authorization = String(request.headers.authorization || '');
    const idToken = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    if (!idToken) {
      response.status(401).json({ success: false, message: 'Please sign in again.' });
      return;
    }

    let session: { uid: string };
    try {
      session = await getAdminAuth().verifyIdToken(idToken, true);
    } catch {
      response.status(401).json({ success: false, message: 'Please sign in again.' });
      return;
    }

    try {
      const profile = await driverProfileForAuthenticatedUser(session.uid);
      if (!profile) {
        response.status(404).json({ success: false, message: 'Your Driver profile is not linked to this account.' });
        return;
      }
      response.setHeader('Cache-Control', 'no-store');
      response.json({ success: true, profile });
    } catch (error: any) {
      console.error('[Driver profile] Protected profile read failed:', { message: String(error?.message || 'unknown error') });
      response.status(503).json({ success: false, message: 'Your Driver profile could not be loaded right now. Please try again.' });
    }
  });

  app.post('/api/driver/phone-login/link', async (request, response) => {
    const session = await authenticatedPhoneSession(request, response);
    if (!session) return;

    try {
      const candidates = new Map<string, Record<string, any>>();
      for (const field of ['phone', 'phone_number', 'mobile_number']) {
        for (const value of phoneLookupValues(session.phone)) {
          const matches = await adminFirestore.list(ADMIN_COLLECTIONS.DRIVER_PROFILES, { [field]: value }, null, 'desc', DRIVER_PROFILE_AUTHORITY_CAP + 1);
          if (matches.length > DRIVER_PROFILE_AUTHORITY_CAP) throw new DriverProfileAuthorityError('Too many matching Driver profiles to safely link.');
          for (const profile of matches) {
            if (profileMatchesVerifiedPhone(profile, session.phone)) candidates.set(String(profile.id), profile);
          }
        }
      }

      const matchingProfiles = [...candidates.values()];
      if (matchingProfiles.length === 0) {
        response.status(403).json({
          success: false,
          message: 'No Driver application matches this verified phone number. Sign in with the email used for your Driver account, or contact HY3N Support.',
        });
        return;
      }

      const previousUserId = String(matchingProfiles[0].user_id || matchingProfiles[0].id || '').trim();
      const identityOwners = new Set(matchingProfiles.map((profile) => String(profile.user_id || profile.id || '').trim()).filter(Boolean));
      if (identityOwners.size > 1) {
        response.status(409).json({
          success: false,
          message: 'This phone number matches more than one Driver application. Please contact HY3N Support so the accounts can be safely reviewed.',
        });
        return;
      }
      const db = getAdminDb();
      const source = await readDriverProfileAuthority(previousUserId, undefined, db);
      const target = previousUserId === session.uid ? source : await readDriverProfileAuthority(session.uid, undefined, db);
      const selected = hasDriverApplicationAuthority(target.canonical) ? target.profile : source.profile;
      if (!selected || !profileMatchesVerifiedPhone(selected, session.phone)) throw new DriverProfileAuthorityError();
      try {
        await claimAccountContacts({
          ownerUid: session.uid,
          role: 'driver',
          contacts: { email: selected.email, phone: session.phone },
          transferableOwnerUids: identityOwners,
        });
      } catch (error) {
        if (error instanceof AccountContactConflictError) {
          response.status(409).json({
            success: false,
            message: 'This phone number is already attached to another HY3N account. Please contact HY3N Support so the accounts can be safely reviewed.',
          });
          return;
        }
        throw error;
      }
      const approvalStatus = await db.runTransaction(async (transaction) => {
        const currentSource = await readDriverProfileAuthority(previousUserId, transaction, db);
        const currentTarget = previousUserId === session.uid ? currentSource : await readDriverProfileAuthority(session.uid, transaction, db);
        if (fingerprint(currentSource) !== fingerprint(source) || fingerprint(currentTarget) !== fingerprint(target)) {
          throw new DriverProfileAuthorityError('Your Driver application changed. Please sign in again.');
        }
        // Lock every initially discovered phone record, including ownerless legacy records.
        for (const profile of matchingProfiles) {
          const snapshot = await transaction.get(db.collection(ADMIN_COLLECTIONS.DRIVER_PROFILES).doc(String(profile.id)));
          const current = snapshot.exists ? { ...snapshot.data(), id: snapshot.id } : null;
          if (!current || driverApplicationAuthorityFingerprint(current) !== driverApplicationAuthorityFingerprint(profile)) throw new DriverProfileAuthorityError();
        }
        const current = hasDriverApplicationAuthority(currentTarget.canonical) ? currentTarget.profile : currentSource.profile;
        if (!current || !profileMatchesVerifiedPhone(current, session.phone)) throw new DriverProfileAuthorityError();
        const profiles = new Map([...currentSource.profiles, ...currentTarget.profiles, ...matchingProfiles].map((profile) => [String(profile.id), profile]));
        const disabled = (profile: Record<string, any> | null) => ['suspended', 'inactive', 'removed', 'disabled']
          .includes(String(profile?.account_status || profile?.status || '').trim().toLowerCase());
        const lifecycle = disabled(currentTarget.canonical) ? currentTarget.canonical! : current;
        const lifecyclePatch = Object.fromEntries(Object.entries(lifecycle).filter(([field]) => field.startsWith('account_')));
        if (disabled(lifecycle) && !lifecyclePatch.account_status) lifecyclePatch.account_status = lifecycle.status;
        const dispatchable = isApprovedDriverProfile(current) && !disabled(lifecycle);
        const presenceIds = [...new Set([session.uid, previousUserId])];
        if (!dispatchable || previousUserId !== session.uid) {
          for (const id of presenceIds) {
            const presence = await transaction.get(db.collection('driver_presence').doc(id));
            if (presence.exists && presence.data()?.user_id && presence.data()?.user_id !== id) throw new DriverProfileAuthorityError();
          }
        }
        const timestamp = new Date().toISOString();
        const approval = driverApprovalState(current);
        const patch = { user_id: session.uid, phone: session.phone, phone_verified: true, phone_verified_at: timestamp,
          phone_login_linked_at: timestamp, updated_date: timestamp, approval_status: approval, application_status: approval,
          approved: approval === 'approved', is_approved: approval === 'approved',
          rejection_reason: approval === 'rejected' ? current.rejection_reason || null : null,
          ...(!dispatchable || previousUserId !== session.uid ? { is_online: false, is_available: false, availability_status: 'offline' } : {}) };
        const { id: _id, ...profileData } = current;
        for (const [id, profile] of profiles) {
          transaction.set(db.collection(ADMIN_COLLECTIONS.DRIVER_PROFILES).doc(id), { ...patch,
            ...(['approved', 'pending', 'rejected'].includes(String(profile.status || '').trim().toLowerCase()) ? { status: approval } : {}) }, { merge: true });
        }
        transaction.set(db.collection(ADMIN_COLLECTIONS.DRIVER_PROFILES).doc(session.uid), { ...profileData, ...patch,
          ...lifecyclePatch,
          ...(['approved', 'pending', 'rejected'].includes(String(current.status || '').trim().toLowerCase()) ? { status: approval } : {}) }, { merge: true });
        if (!dispatchable || previousUserId !== session.uid) {
          for (const id of presenceIds) transaction.set(db.collection('driver_presence').doc(id), { user_id: id,
            approval_status: id === session.uid ? approval : 'pending', approved: id === session.uid && approval === 'approved',
            is_approved: id === session.uid && approval === 'approved', account_status: lifecyclePatch.account_status || 'active',
            is_online: false, is_available: false, availability_status: 'offline', offline_reason: 'phone_login_linked', updated_date: timestamp }, { merge: true });
        }
        return approval;
      });
      response.json({ success: true, profileId: session.uid, approvalStatus });
    } catch (error: any) {
      console.error('[Driver phone login] Profile link failed:', { message: String(error?.message || 'unknown error') });
      response.status(503).json({ success: false, message: 'We could not open your Driver account right now. Please try again.' });
    }
  });
}
