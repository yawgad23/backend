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
    return { uid: decoded.uid, email: normalizeAccountEmail(decoded.email) };
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

function assertedContacts(input: { email: string; phone: string }, sessionEmail: string | null) {
  const email = normalizeAccountEmail(input.email);
  const phone = normalizeAccountPhone(input.phone);
  if (!email || !phone) throw new Error('Enter a valid email address and Ghana mobile number.');
  // Do not let a signed-in user reserve an arbitrary person’s email. The email
  // ownership source is Firebase Authentication, not the request body.
  if (sessionEmail && sessionEmail !== email) throw new Error('Use the email address linked to this HY3N sign-in.');
  return { email: sessionEmail || email, phone };
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
  const profile = {
    ...(existing || {}),
    ...patch,
    user_id: uid,
  };
  await adminFirestore.set(collection, uid, profile);
  if (existing && String(existing.id) !== uid) {
    await adminFirestore.set(collection, String(existing.id), patch);
  }
  return { id: uid, ...profile };
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
      const contacts = assertedContacts(parsed.data, session.email);
      await claimAccountContacts({ ownerUid: session.uid, role: 'rider', contacts });
      const profile = await writeCanonicalProfile('rider', session.uid, {
        full_name: parsed.data.fullName,
        email: contacts.email,
        phone: contacts.phone,
        account_status: 'active',
        registration_source: 'rider_app',
        contact_claimed_at: new Date().toISOString(),
        ...(parsed.data.inviteCode ? { invite_code_used: parsed.data.inviteCode.toUpperCase() } : {}),
        loyalty_points: 0,
        loyalty_tier: 'Bronze',
        rating: 5,
        total_rides: 0,
        saved_locations: [],
      });
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
      const contacts = assertedContacts(parsed.data, session.email);
      await claimAccountContacts({ ownerUid: session.uid, role: 'driver', contacts });
      const documents = parsed.data.documents;
      const existing = await existingProfile('driver', session.uid);
      const priorApproval = String(existing?.approval_status || 'pending').toLowerCase();
      const profile = await writeCanonicalProfile('driver', session.uid, {
        full_name: parsed.data.fullName,
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
      }, session.email);
      await claimAccountContacts({ ownerUid: session.uid, role, contacts });
      const profile = await writeCanonicalProfile(role, session.uid, {
        ...(parsed.data.fullName ? { full_name: parsed.data.fullName } : {}),
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
