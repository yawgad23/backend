import type { Express, Request, Response } from 'express';
import { ADMIN_COLLECTIONS, adminFirestore, getAdminAuth } from './firebaseAdmin';

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

function approved(profile: Record<string, any>): boolean {
  const status = String(profile.approval_status ?? profile.application_status ?? profile.status ?? '').trim().toLowerCase();
  return status === 'approved' || profile.approved === true || profile.is_approved === true;
}

function latestFirst(left: Record<string, any>, right: Record<string, any>): number {
  if (approved(left) !== approved(right)) return approved(left) ? -1 : 1;
  return String(right.updated_date || right.created_date || '').localeCompare(
    String(left.updated_date || left.created_date || ''),
  );
}

async function authenticatedPhoneSession(request: Request, response: Response) {
  const authorization = String(request.headers.authorization || '');
  const idToken = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!idToken) {
    response.status(401).json({ success: false, message: 'Please verify your phone number and sign in again.' });
    return null;
  }

  try {
    const decoded = await getAdminAuth().verifyIdToken(idToken);
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
  app.post('/api/driver/phone-login/link', async (request, response) => {
    const session = await authenticatedPhoneSession(request, response);
    if (!session) return;

    try {
      const candidates = new Map<string, Record<string, any>>();
      for (const field of ['phone', 'phone_number', 'mobile_number']) {
        for (const value of phoneLookupValues(session.phone)) {
          const matches = await adminFirestore.list(ADMIN_COLLECTIONS.DRIVER_PROFILES, { [field]: value }, null, 'desc', 20);
          for (const profile of matches) {
            if (profileMatchesVerifiedPhone(profile, session.phone)) candidates.set(String(profile.id), profile);
          }
        }
      }

      const matchingProfiles = [...candidates.values()].sort(latestFirst);
      if (matchingProfiles.length === 0) {
        response.status(403).json({
          success: false,
          message: 'No Driver application matches this verified phone number. Sign in with the email used for your Driver account, or contact HY3N Support.',
        });
        return;
      }

      const selected = matchingProfiles[0];
      const previousUserId = String(selected.user_id || selected.id || '').trim();
      const identityOwners = new Set(matchingProfiles.map((profile) => String(profile.user_id || profile.id || '').trim()).filter(Boolean));
      if (identityOwners.size > 1) {
        response.status(409).json({
          success: false,
          message: 'This phone number matches more than one Driver application. Please contact HY3N Support so the accounts can be safely reviewed.',
        });
        return;
      }
      const relatedProfiles = previousUserId
        ? await adminFirestore.list(ADMIN_COLLECTIONS.DRIVER_PROFILES, { user_id: previousUserId }, null, 'desc', 20)
        : [];
      const profilesToLink = [...matchingProfiles, ...relatedProfiles]
        .filter((profile, index, list) => list.findIndex((item) => item.id === profile.id) === index);
      const timestamp = new Date().toISOString();
      const patch = {
        user_id: session.uid,
        phone: session.phone,
        phone_verified: true,
        phone_verified_at: timestamp,
        phone_login_linked_at: timestamp,
      };

      // Preserve legacy application records for the administrator while making
      // the UID-keyed profile used by dispatch and mobile recovery canonical.
      await Promise.all(profilesToLink.map((profile) => adminFirestore.set(
        ADMIN_COLLECTIONS.DRIVER_PROFILES,
        String(profile.id),
        patch,
      )));
      const { id: _id, ...profileData } = selected;
      await adminFirestore.set(ADMIN_COLLECTIONS.DRIVER_PROFILES, session.uid, {
        ...profileData,
        ...patch,
      });

      response.json({ success: true, profileId: session.uid, approvalStatus: selected.approval_status || 'pending' });
    } catch (error: any) {
      console.error('[Driver phone login] Profile link failed:', { message: String(error?.message || 'unknown error') });
      response.status(503).json({ success: false, message: 'We could not open your Driver account right now. Please try again.' });
    }
  });
}
