import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import {
  AccountContactCapacityError,
  AccountContactConflictError,
  claimAccountContacts,
  normalizeAccountEmail,
  normalizeAccountPhone,
} from './accountContactClaims';
import { ADMIN_COLLECTIONS, adminFirestore, getAdminAuth, getAdminDb } from './firebaseAdmin';
import { requiredAccountFullName, requiredRiderIdentity, riderProfileCompletionMessage } from './riderIdentity';
import { selectVerifiedRiderAccountRecovery } from './riderAccountRecovery';
import { DRIVER_DOCUMENT_DEFINITIONS, driverDocumentKeys, driverManifestDetails, DriverManifestError } from './driverDocumentManifest';
import { readDriverDocumentManifest } from './driverDocumentManifestRead';
import { driverApplicationAuthorityFingerprint, driverApprovalState, isApprovedDriverProfile, readDriverProfileAuthority,
  DriverProfileAuthorityError, type DriverProfileAuthority } from './driverApproval';

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
  }).superRefine((documents, context) => {
    const requiredDocuments: Array<[keyof typeof documents, string]> = [
      ['ghanaCardFront', 'Ghana Card (Front)'],
      ['ghanaCardBack', 'Ghana Card (Back)'],
      ['licenseFront', "Driver's License (Front)"],
      ['licenseBack', "Driver's License (Back)"],
      ['profilePhoto', 'Your Photo (Selfie)'],
      ['vehiclePhoto', 'Vehicle Photo'],
    ];
    const missing = requiredDocuments.filter(([key]) => !documents[key]).map(([, label]) => label);
    if (missing.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Upload all required verification documents before submitting: ${missing.join(', ')}.`,
      });
    }
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
  if (role === 'driver') return (await readDriverProfileAuthority(uid)).profile;
  const collection = collectionFor(role);
  const canonical = await adminFirestore.get(collection, uid);
  if (canonical) return canonical;
  const matching = await adminFirestore.list(collection, { user_id: uid }, null, 'desc', 20);
  return matching[0] || null;
}

async function writeCanonicalProfile(role: AccountRole, uid: string, patch: Record<string, any>) {
  if (role === 'driver') return saveDriverApplication(uid, patch, false);
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

function normalizedMaterial(profile: Record<string, any>): string {
  const details = driverManifestDetails(profile);
  const normalize = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();
  const { momoNumber: _momo, phone: _phone, acceptedCategories, ...identityVehicle } = details;
  const phone = normalizeAccountPhone(details.phone) || normalize(details.phone);
  const documents = driverDocumentKeys.map((key) => {
    let reference = profile[DRIVER_DOCUMENT_DEFINITIONS[key].field];
    if (key === 'vehiclePhoto' && !reference && typeof profile.vehicle_registration_url === 'string') {
      try {
        const path = decodeURIComponent(new URL(profile.vehicle_registration_url).pathname);
        if (/\/(vehicle-photo|vehicle_photo)\.jpg$/.test(path)) reference = profile.vehicle_registration_url;
      } catch { /* Unknown registration scans are not vehicle photos. */ }
    }
    return [key, typeof reference === 'string' ? reference.trim() : ''];
  });
  return JSON.stringify({ details: Object.fromEntries(Object.entries(identityVehicle).map(([key, value]) => [key, normalize(value)])),
    phone, categories: [...new Set(acceptedCategories.map(normalize))].sort(), documents });
}

function authorityFingerprint(authority: DriverProfileAuthority): string {
  return JSON.stringify({ selected: authority.profile?.id || null,
    records: authority.profiles.map((profile) => [profile.id, driverApplicationAuthorityFingerprint(profile)])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))) });
}

/** Prospective application writes cannot restore an administrator decision read before the transaction. */
export async function saveDriverApplication(uid: string, materialPatch: Record<string, any>, resubmission = true) {
  const allowedFields = new Set(['full_name', 'email', 'phone', 'momo_number', 'city', 'service_type', 'ride_categories', 'accepted_categories',
    'vehicle_make', 'vehicle_model', 'vehicle_plate', 'license_plate', 'vehicle_color', 'vehicle_colour', 'vehicle_year',
    'registration_source', 'contact_claimed_at', ...driverDocumentKeys.map((key) => DRIVER_DOCUMENT_DEFINITIONS[key].field)]);
  materialPatch = Object.fromEntries(Object.entries(materialPatch).filter(([field]) => allowedFields.has(field)));
  const db = getAdminDb();
  const expected = await readDriverProfileAuthority(uid, undefined, db);
  const expectedFingerprint = authorityFingerprint(expected);
  const eventRef = db.collection('account_lifecycle_events').doc();
  return db.runTransaction(async (transaction) => {
    const authority = await readDriverProfileAuthority(uid, transaction, db);
    if (authorityFingerprint(authority) !== expectedFingerprint) {
      throw new DriverProfileAuthorityError('Your Driver application or administrator decision changed. Refresh and submit again.');
    }
    const existing = authority.profile || {};
    const changed = normalizedMaterial(existing) !== normalizedMaterial({ ...existing, ...materialPatch });
    const previous = driverApprovalState(existing);
    const approval = previous === 'approved' && !changed ? 'approved'
      : changed || resubmission ? 'pending' : previous;
    const dispatchable = approval === 'approved' && isApprovedDriverProfile(existing);
    const presenceRef = db.collection('driver_presence').doc(uid);
    const presence = !dispatchable ? await transaction.get(presenceRef) : null;
    if (presence?.exists && presence.data()?.user_id && presence.data()?.user_id !== uid) throw new DriverProfileAuthorityError();
    const now = new Date().toISOString();
    const approvalPatch = {
      approval_status: approval, application_status: approval, approved: approval === 'approved', is_approved: approval === 'approved',
      ...(approval !== 'rejected' ? { rejection_reason: null } : {}),
      ...(!dispatchable ? { is_online: false, is_available: false, availability_status: 'offline' } : {}),
    };
    const patch = { ...materialPatch, ...approvalPatch, user_id: uid, updated_date: now,
      ...(resubmission || changed ? { application_submitted_at: now } : {}) };
    const canonical = { ...profileWithoutIdentityFields(existing), ...patch,
      // Preserve account lifecycle, trusted test classification, financial/trip counters and decisions.
      ...(!existing.account_status && !existing.status ? { account_status: 'active' } : {}),
      rating: existing.rating ?? 5, total_rides: existing.total_rides ?? 0,
      ...(!existing.created_date ? { created_date: now } : {}) };
    const legacyApproval = (profile: Record<string, any>) => ['approved', 'pending', 'rejected'].includes(String(profile.status || '').trim().toLowerCase())
      ? { status: approval } : {};
    transaction.set(db.collection(ADMIN_COLLECTIONS.DRIVER_PROFILES).doc(uid), { ...canonical, ...legacyApproval(existing) }, { merge: true });
    for (const profile of authority.profiles) {
      if (profile.id !== uid) transaction.set(db.collection(ADMIN_COLLECTIONS.DRIVER_PROFILES).doc(String(profile.id)),
        { ...patch, ...legacyApproval(profile) }, { merge: true });
    }
    if (!dispatchable) transaction.set(presenceRef, { user_id: uid, ...approvalPatch,
      account_status: existing.account_status || (['suspended', 'inactive', 'removed', 'disabled'].includes(String(existing.status || '').trim().toLowerCase()) ? existing.status : 'active'),
      offline_reason: `application_${approval}`, updated_date: now }, { merge: true });
    if (resubmission || changed) transaction.create(eventRef, { user_id: uid, account_role: 'driver', action: 'driver_application_submitted',
      actor_type: 'account_owner', actor_id: uid, created_date: now, previous_approval_status: previous, new_approval_status: approval,
      material_changed: changed, linked_profile_ids: authority.profiles.map((profile) => profile.id) });
    return { ...canonical, id: uid };
  });
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
  app.get('/api/account/profile/driver/documents', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    const session = await authenticatedIdentity(request, response);
    if (!session) return;
    try {
      // Target only the revocation-checked token UID, never query/body identity.
      const manifest = await readDriverDocumentManifest(session.uid);
      response.status(200).json({ success: true, manifest });
    } catch (error) {
      const failure = error instanceof DriverManifestError ? error : new DriverManifestError(
        503, 'DOCUMENT_MANIFEST_UNAVAILABLE', 'Your Driver application could not be checked. Please try again.',
      );
      response.status(failure.status).json({ success: false, code: failure.code, message: failure.message });
    }
  });

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
      response.status(400).json({
        success: false,
        code: 'INVALID_PROFILE',
        message: parsed.error.issues[0]?.message || 'Please complete the required Driver account and vehicle details.',
      });
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
      const profile = await saveDriverApplication(session.uid, {
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
        ...Object.fromEntries(driverDocumentKeys.map((key) => [DRIVER_DOCUMENT_DEFINITIONS[key].field, documents[key]])),
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
