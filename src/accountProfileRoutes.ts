import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import {
  AccountContactCapacityError,
  AccountContactConflictError,
  claimAccountContacts,
  normalizeAccountEmail,
  normalizeAccountPhone,
} from './accountContactClaims';
import { ADMIN_COLLECTIONS, adminFirestore, getAdminAuth } from './firebaseAdmin';
import { requiredAccountFullName, requiredRiderIdentity, riderProfileCompletionMessage } from './riderIdentity';
import { selectVerifiedRiderAccountRecovery } from './riderAccountRecovery';

type AccountRole = 'rider' | 'driver';

const riderProfileInput = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254),
  phone: z.string().trim().min(7).max(40),
  inviteCode: z.string().trim().min(3).max(32).optional(),
});

const driverProfileInput = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254),
  phone: z.string().trim().min(7).max(40),
  momoNumber: z.string().trim().max(40).optional().default(''),
  city: z.string().trim().min(1).max(120),
  serviceType: z.enum(['car', 'okada', 'delivery']),
  rideCategories: z.array(z.enum(['standard', 'comfort', 'kantanka', 'car_delivery', 'executive', 'okada', 'express_delivery'])).min(1).max(6),
  vehicleMake: z.string().trim().min(1).max(80),
  vehicleModel: z.string().trim().min(1).max(120),
  vehiclePlate: z.string().trim().min(1).max(40),
  vehicleColor: z.string().trim().max(80).optional().default(''),
  vehicleYear: z.string().trim().max(4).optional().default(''),
  documents: z.object({
    ghanaCardFront: z.string().trim().max(4_000).optional().default(''),
    ghanaCardBack: z.string().trim().max(4_000).optional().default(''),
    licenseFront: z.string().trim().max(4_000).optional().default(''),
    licenseBack: z.string().trim().max(4_000).optional().default(''),
    profilePhoto: z.string().trim().max(4_000).optional().default(''),
    vehiclePhoto: z.string().trim().max(4_000).optional().default(''),
    insurance: z.string().trim().max(4_000).optional().default(''),
    roadworthy: z.string().trim().max(4_000).optional().default(''),
  }),
});

const contactUpdateInput = z.object({
  role: z.enum(['rider', 'driver']),
  fullName: z.string().trim().min(2).max(120).optional(),
  email: z.string().trim().email().max(254).optional(),
  phone: z.string().trim().min(7).max(40).optional(),
});

function bearerToken(request: Request): string {
  const authorization = String(request.headers.authorization || '');
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
}

async function authenticatedIdentity(request: Request, response: Response) {
  const token = bearerToken(request);
  if (!token) {
    response.status(401).json({ success: false, code: 'AUTH_REQUIRED', message: 'Please sign in again before updating your account.' });
    return null;
  }
  try {
    const decoded = await getAdminAuth().verifyIdToken(token, true);
    return {
      uid: decoded.uid,
      email: normalizeAccountEmail(decoded.email),
      phone: normalizeAccountPhone(decoded.phone_number),
    };
  } catch {
    response.status(401).json({ success: false, code: 'AUTH_REQUIRED', message: 'Your session has expired. Please sign in again.' });
    return null;
  }
}

function collectionFor(role: AccountRole) {
  return role === 'rider' ? ADMIN_COLLECTIONS.RIDER_PROFILES : ADMIN_COLLECTIONS.DRIVER_PROFILES;
}

function profileForResponse(profile: Record<string, any>) {
  return {
    id: String(profile.id || profile.user_id || ''),
    userId: String(profile.user_id || profile.id || ''),
    fullName: String(profile.full_name || ''),
    email: String(profile.email || ''),
    phone: String(profile.phone || ''),
  };
}

function profileWithoutIdentityFields(profile: Record<string, any>): Record<string, any> {
  const {
    id: _id,
    user_id: _userId,
    full_name: _fullName,
    name: _name,
    display_name: _displayName,
    email: _email,
    phone: _phone,
    phone_number: _phoneNumber,
    mobile_number: _mobileNumber,
    ...safeProfileFields
  } = profile;
  return safeProfileFields;
}

function duplicateResponse(response: Response, error: unknown) {
  if (error instanceof AccountContactConflictError) {
    response.status(409).json({ success: false, code: error.code, message: error.message });
    return true;
  }
  if (error instanceof AccountContactCapacityError) {
    response.status(503).json({ success: false, code: error.code, message: error.message });
    return true;
  }
  return false;
}

function assertedContacts(
  input: { email: string; phone: string },
  session: { email: string | null; phone: string | null },
) {
  const email = normalizeAccountEmail(input.email);
  const phone = normalizeAccountPhone(input.phone);
  if (!email || !phone) throw new Error('Enter a valid email address and Ghana mobile number.');
  // Do not let a signed-in user reserve an arbitrary person’s email. The email
  // ownership source is Firebase Authentication, not the request body.
  if (session.email && session.email !== email) throw new Error('Use the email address linked to this HY3N sign-in.');
  // A phone-authenticated Firebase session likewise proves one exact phone
  // number. It must not claim an unrelated profile by submitting another one.
  if (session.phone && session.phone !== phone) throw new Error('Use the phone number verified by this HY3N sign-in.');
  return { email: session.email || email, phone: session.phone || phone };
}

async function existingProfile(role: AccountRole, uid: string) {
  const collection = collectionFor(role);
  const canonical = await adminFirestore.get(collection, uid);
  if (canonical) return canonical;
  const matching = await adminFirestore.list(collection, { user_id: uid }, null, 'desc', 20);
  return matching[0] || null;
}

async function writeCanonicalProfile(role: AccountRole, uid: string, patch: Record<string, any>) {
  const collection = collectionFor(role);
  const existing = await existingProfile(role, uid);
  const existingData = existing ? profileWithoutIdentityFields(existing) : {};
  const profile = {
    ...existingData,
    ...patch,
    user_id: uid,
  };
  await adminFirestore.set(collection, uid, profile);
  if (existing && String(existing.id) !== uid) {
    await adminFirestore.set(collection, String(existing.id), patch);
  }
  return { id: uid, ...profile };
}

async function legacyRiderRecovery(
  session: { uid: string; email: string | null; phone: string | null },
  contacts: { email: string; phone: string },
) {
  if (!session.email && !session.phone) return null;
  const riderProfiles = await adminFirestore.listAll(ADMIN_COLLECTIONS.RIDER_PROFILES);
  if (riderProfiles.truncated) throw new AccountContactCapacityError();
  return selectVerifiedRiderAccountRecovery({
    currentUid: session.uid,
    sessionEmail: session.email,
    sessionPhone: session.phone,
    requestedEmail: contacts.email,
    requestedPhone: contacts.phone,
    riderProfiles: riderProfiles.records,
  });
}

export function registerAccountProfileRoutes(app: Express) {
  app.post('/api/account/profile/rider', async (request, response) => {
    const session = await authenticatedIdentity(request, response);
    if (!session) return;
    const parsed = riderProfileInput.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ success: false, code: 'INVALID_PROFILE', message: 'Please enter a valid name, email address, and Ghana mobile number.' });
      return;
    }

    try {
      const contacts = assertedContacts(parsed.data, session);
      const riderIdentity = requiredRiderIdentity({
        full_name: parsed.data.fullName,
        email: contacts.email,
        phone: contacts.phone,
      });
      if (!riderIdentity) {
        response.status(400).json({ success: false, code: 'INVALID_PROFILE', message: riderProfileCompletionMessage() });
        return;
      }
      const currentProfile = await existingProfile('rider', session.uid);
      // Some legacy Rider profiles predate the current Firebase UID. Transfer
      // only the one profile whose saved email and Ghana phone both exactly
      // match this authenticated session; this also repairs an incomplete
      // profile previously created under the current UID. Any collision stays
      // blocked rather than selecting an account.
      const recovery = await legacyRiderRecovery(session, contacts);
      await claimAccountContacts({
        ownerUid: session.uid,
        role: 'rider',
        contacts,
        ...(recovery ? { transferableOwnerUids: [recovery.legacyOwnerUid] } : {}),
      });
      const preservedProfile = { ...(currentProfile || {}), ...(recovery?.profile || {}) };
      const profile = await writeCanonicalProfile('rider', session.uid, {
        ...profileWithoutIdentityFields(preservedProfile),
        full_name: riderIdentity.fullName,
        email: riderIdentity.email,
        phone: riderIdentity.phone,
        account_status: preservedProfile.account_status || 'active',
        registration_source: recovery ? 'verified_rider_account_recovery' : (preservedProfile.registration_source || 'rider_app'),
        contact_claimed_at: new Date().toISOString(),
        ...(parsed.data.inviteCode ? { invite_code_used: parsed.data.inviteCode.toUpperCase() } : {}),
        loyalty_points: preservedProfile.loyalty_points ?? 0,
        loyalty_tier: preservedProfile.loyalty_tier ?? 'Bronze',
        rating: preservedProfile.rating ?? 5,
        total_rides: preservedProfile.total_rides ?? 0,
        saved_locations: preservedProfile.saved_locations ?? [],
      });
      if (recovery && recovery.profile.id !== session.uid) {
        // Keep the old document as an internal legacy alias so historical
        // reference IDs remain traceable, but map it to the one recovered UID.
        await adminFirestore.set(ADMIN_COLLECTIONS.RIDER_PROFILES, String(recovery.profile.id), {
          user_id: session.uid,
          profile_migrated_to: session.uid,
          profile_migrated_at: new Date().toISOString(),
          profile_migration_reason: 'verified_email_and_phone_recovery',
        });
      }
      response.status(200).json({ success: true, profile: profileForResponse(profile) });
    } catch (error) {
      if (duplicateResponse(response, error)) return;
      const message = error instanceof Error ? error.message : 'Your account could not be saved. Please try again.';
      response.status(400).json({ success: false, code: 'PROFILE_SAVE_FAILED', message });
    }
  });

  app.post('/api/account/profile/driver', async (request, response) => {
    const session = await authenticatedIdentity(request, response);
    if (!session) return;
    const parsed = driverProfileInput.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ success: false, code: 'INVALID_PROFILE', message: 'Please complete the required Driver account and vehicle details.' });
      return;
    }

    try {
      const contacts = assertedContacts(parsed.data, session);
      const fullName = requiredAccountFullName(parsed.data.fullName);
      if (!fullName) {
        response.status(400).json({ success: false, code: 'INVALID_PROFILE', message: 'Enter your real full name before submitting a Driver application.' });
        return;
      }
      await claimAccountContacts({ ownerUid: session.uid, role: 'driver', contacts });
      const documents = parsed.data.documents;
      const existing = await existingProfile('driver', session.uid);
      const priorApproval = String(existing?.approval_status || 'pending').toLowerCase();
      const profile = await writeCanonicalProfile('driver', session.uid, {
        full_name: fullName,
        email: contacts.email,
        phone: contacts.phone,
        momo_number: parsed.data.momoNumber,
        city: parsed.data.city,
        service_type: parsed.data.serviceType,
        ride_categories: parsed.data.rideCategories,
        accepted_categories: parsed.data.rideCategories,
        vehicle_make: parsed.data.vehicleMake,
        vehicle_model: parsed.data.vehicleModel,
        vehicle_plate: parsed.data.vehiclePlate,
        license_plate: parsed.data.vehiclePlate,
        vehicle_color: parsed.data.vehicleColor,
        vehicle_colour: parsed.data.vehicleColor,
        vehicle_year: parsed.data.vehicleYear,
        ghana_card_front_url: documents.ghanaCardFront,
        ghana_card_back_url: documents.ghanaCardBack,
        drivers_license_front_url: documents.licenseFront,
        drivers_license_back_url: documents.licenseBack,
        profile_photo_url: documents.profilePhoto,
        vehicle_registration_url: documents.vehiclePhoto,
        insurance_url: documents.insurance,
        roadworthy_url: documents.roadworthy,
        approval_status: priorApproval === 'approved' ? 'approved' : 'pending',
        is_online: false,
        is_available: false,
        availability_status: 'offline',
        rating: Number(existing?.rating || 5),
        total_rides: Number(existing?.total_rides || 0),
        registration_source: 'driver_app',
        contact_claimed_at: new Date().toISOString(),
      });
      response.status(200).json({ success: true, profile: profileForResponse(profile) });
    } catch (error) {
      if (duplicateResponse(response, error)) return;
      const message = error instanceof Error ? error.message : 'Your Driver application could not be saved. Please try again.';
      response.status(400).json({ success: false, code: 'PROFILE_SAVE_FAILED', message });
    }
  });

  app.patch('/api/account/profile/contact', async (request, response) => {
    const session = await authenticatedIdentity(request, response);
    if (!session) return;
    const parsed = contactUpdateInput.safeParse(request.body);
    if (!parsed.success || (!parsed.data.fullName && !parsed.data.email && !parsed.data.phone)) {
      response.status(400).json({ success: false, code: 'INVALID_PROFILE', message: 'Please enter valid account contact details.' });
      return;
    }

    try {
      const role = parsed.data.role;
      const existing = await existingProfile(role, session.uid);
      if (!existing) {
        response.status(404).json({ success: false, code: 'PROFILE_NOT_FOUND', message: 'Your account profile was not found. Please sign in again.' });
        return;
      }
      const contacts = assertedContacts({
        email: parsed.data.email || String(existing.email || ''),
        phone: parsed.data.phone || String(existing.phone || existing.phone_number || ''),
      }, session);
      const fullName = requiredAccountFullName(
        parsed.data.fullName || existing.full_name || existing.name || existing.display_name,
      );
      if (!fullName) {
        response.status(400).json({ success: false, code: 'INVALID_PROFILE', message: role === 'rider'
          ? riderProfileCompletionMessage()
          : 'Enter your real full name before saving account details.' });
        return;
      }
      const riderIdentity = role === 'rider'
        ? requiredRiderIdentity({
            ...existing,
            full_name: fullName,
            email: contacts.email,
            phone: contacts.phone,
          })
        : null;
      if (role === 'rider' && !riderIdentity) {
        response.status(400).json({ success: false, code: 'INVALID_PROFILE', message: riderProfileCompletionMessage() });
        return;
      }
      await claimAccountContacts({ ownerUid: session.uid, role, contacts });
      const profile = await writeCanonicalProfile(role, session.uid, {
        ...(role === 'rider'
          ? { full_name: riderIdentity!.fullName }
          : { full_name: fullName }),
        email: contacts.email,
        phone: contacts.phone,
        contact_claimed_at: new Date().toISOString(),
      });
      response.json({ success: true, profile: profileForResponse(profile) });
    } catch (error) {
      if (duplicateResponse(response, error)) return;
      const message = error instanceof Error ? error.message : 'Your contact details could not be updated. Please try again.';
      response.status(400).json({ success: false, code: 'PROFILE_SAVE_FAILED', message });
    }
  });
}
