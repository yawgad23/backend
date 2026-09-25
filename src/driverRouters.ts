import { z } from 'zod';
import { publicProcedure, router } from './trpc';
import { adminFirestore, ADMIN_COLLECTIONS } from './firebaseAdmin';
import { sendTripReceiptEmail } from './email';
import { getDailyPlatformFee } from './platformFee';
import { canCompleteTrip, canStartTrip, getCappedCompatibilityDistanceKm, getMeteredFareBreakdown, getMeteredTripFare, getQuotedRideFare, getTripChargeTotal, getTripDurationMinutes } from './fareAuthority';
import { advanceTripMeter, initializeTripMeter } from './tripMeter';
import { sendDriverLocationLiveActivityUpdates, sendRideLiveActivityUpdate } from './liveActivities';
import { completedRidesForPeriod, earningsTrend, numericRideFare, numericTip, paidFeesForPeriod } from './driverEarnings';
import { isOnlineWithFreshLocation, profilePresencePatch } from './driverPresence';

const now = () => new Date().toISOString();
const dateKey = () => now().slice(0, 10);
const driverIdInput = z.object({ driverId: z.string().min(1) });

async function profile(driverId: string) {
  // Driver profiles created by the original admin workflow use auto IDs while
  // mobile authentication uses Firebase UIDs. Always prefer the approved
  // profile whose `user_id` matches the signed-in user, then fall back to a
  // UID-keyed document only for new registrations.
  const matches = await adminFirestore.list(ADMIN_COLLECTIONS.DRIVER_PROFILES, { user_id: driverId }, null);
  if (matches.length > 0) {
    return matches.sort((a: any, b: any) => {
      const approved = (item: any) => item.approval_status === 'approved' || item.approved === true || item.is_approved === true;
      if (approved(a) !== approved(b)) return approved(a) ? -1 : 1;
      return String(b.updated_date || b.created_date || '').localeCompare(String(a.updated_date || a.created_date || ''));
    })[0];
  }
  return adminFirestore.get(ADMIN_COLLECTIONS.DRIVER_PROFILES, driverId);
}

async function rideFor(driverId: string, rideId: string) {
  const ride = await adminFirestore.get(ADMIN_COLLECTIONS.RIDES, rideId);
  if (!ride) throw new Error('Ride not found.');
  if (ride.driver_id && ride.driver_id !== driverId) throw new Error('This ride is assigned to another driver.');
  return ride;
}

function withRide(ride: Record<string, any>, patch: Record<string, any>): Record<string, any> {
  return { ...ride, ...patch, updated_date: now() };
}

function publishLiveActivity(ride: Record<string, any>, force = false) {
  void sendRideLiveActivityUpdate(ride, { force }).catch((error) => {
    // A Lock Screen update must never block the real ride-state transition.
    console.error('[LiveActivity] Ride state push failed:', error);
  });
}

function receiptEmail(value: unknown) {
  const email = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

/**
 * A ride keeps the recipient email at booking time, but older phone-authored
 * rides can predate that field. Resolve the Rider's own profile only on the
 * trusted backend so a completion still receives its automatic receipt.
 */
async function receiptEmailForRide(ride: Record<string, any>) {
  const recordedEmail = receiptEmail(ride.rider_email || ride.riderEmail);
  if (recordedEmail) return recordedEmail;

  const riderId = String(ride.rider_id || ride.riderId || '').trim();
  if (!riderId) return '';
  try {
    const uidProfile = await adminFirestore.get(ADMIN_COLLECTIONS.RIDER_PROFILES, riderId);
    const directProfileEmail = receiptEmail(uidProfile?.email);
    if (directProfileEmail) return directProfileEmail;

    const profiles = await adminFirestore.list(ADMIN_COLLECTIONS.RIDER_PROFILES, { user_id: riderId }, null, 'desc', 5);
    return receiptEmail(profiles.find((profile: any) => receiptEmail(profile.email))?.email);
  } catch (error) {
    console.warn('[ReceiptEmail] Could not resolve Rider profile email:', error);
    return '';
  }
}

/**
 * Store an append-only operational event for support and safety review. The
 * ride document remains the source of truth for the current state; this log
 * answers how it reached that state without duplicating rider contact data.
 */
async function recordRideEvent(input: {
  rideId: string;
  type: string;
  actorId?: string;
  actorRole: 'driver' | 'rider' | 'system';
  status?: string;
  metadata?: Record<string, unknown>;
}) {
  try {
    await adminFirestore.create(ADMIN_COLLECTIONS.RIDE_EVENTS, {
      ride_id: input.rideId,
      event_type: input.type,
      actor_id: input.actorId || null,
      actor_role: input.actorRole,
      ride_status: input.status || null,
      metadata: input.metadata || {},
      created_at: now(),
    });
  } catch (error) {
    // Event logging must not block a legitimate rider or Driver state change.
    console.error('[RideEvents] Unable to record event:', error);
  }
}

function isOnline(profileData: Record<string, any> | null) {
  return isOnlineWithFreshLocation(profileData);
}

/** Keep the legacy approved profile and UID presence document in agreement. */
async function setDriverProfilePresence(driverId: string, patch: Record<string, any>) {
  const canonical = await profile(driverId);
  const matches = await adminFirestore.list(ADMIN_COLLECTIONS.DRIVER_PROFILES, { user_id: driverId }, null, 'desc', 10);
  const documentIds = new Set<string>([
    driverId,
    ...(canonical?.id ? [String(canonical.id)] : []),
    ...matches.map((candidate) => String(candidate.id)),
  ]);
  await Promise.all([...documentIds].map((id) => adminFirestore.set(
    ADMIN_COLLECTIONS.DRIVER_PROFILES,
    id,
    { user_id: driverId, ...patch },
  )));
}

function hasDriverFeeTestBypass(driverId: string) {
  return String(process.env.DRIVER_FEE_TEST_BYPASS_DRIVER_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(driverId);
}

async function hasCurrentPlatformFee(driverId: string) {
  // Keep the offer listener aligned with the app's payment gate. When a test
  // environment explicitly disables the gate, offers are still allowed; in
  // production, a paid commission remains valid for 24 hours.
  if (process.env.DRIVER_PLATFORM_FEE_GATE_ENABLED === 'false') return true;
  if (hasDriverFeeTestBypass(driverId)) return true;
  const records = await adminFirestore.list(
    ADMIN_COLLECTIONS.DAILY_COMMISSION,
    { driver_id: driverId },
    null,
    'desc',
    100,
  );
  return records.some((record: any) => {
    if (record.status !== 'paid' && record.status !== 'confirmed' && record.status !== 'completed') return false;
    const paidAt = record.submitted_at || record.admin_override_at || record.created_date || record.date;
    const paidTime = new Date(paidAt || 0).getTime();
    return Number.isFinite(paidTime) && Date.now() - paidTime < 24 * 60 * 60 * 1000;
  });
}

function hasCategory(profileData: Record<string, any>, category: unknown) {
  const requested = String(category || '').toLowerCase();
  const categories = Array.isArray(profileData.ride_categories)
    ? profileData.ride_categories.map((value: unknown) => String(value).toLowerCase())
    : [];
  if (categories.length > 0) return categories.includes(requested);
  const serviceType = String(profileData.service_type || '').toLowerCase();
  return ['standard', 'comfort', 'kantanka', 'executive'].includes(requested)
    ? (!serviceType || serviceType === 'car')
    : requested === 'okada'
      ? serviceType === 'okada'
      : requested === 'express_delivery'
        ? serviceType === 'delivery'
        : false;
}

function locationOf(profileData: Record<string, any>) {
  const value = profileData.current_location || profileData.location || {};
  const lat = Number(value.latitude ?? value.lat ?? profileData.latitude);
  const lng = Number(value.longitude ?? value.lng ?? profileData.longitude);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function pickupDistanceKm(ride: Record<string, any>, driverLocation: { lat: number; lng: number } | null) {
  const pickup = ride.pickup || {};
  const lat = Number(pickup.lat ?? pickup.latitude);
  const lng = Number(pickup.lng ?? pickup.longitude);
  if (!driverLocation || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const latKm = (driverLocation.lat - lat) * 111;
  const lngKm = (driverLocation.lng - lng) * 111 * Math.cos(lat * Math.PI / 180);
  return Math.hypot(latKm, lngKm);
}

/** Only a matched MoMo ride receives a Driver's valid local payment number. */
function directMomoNumber(value: unknown): string | null {
  const digits = String(value || '').replace(/\D/g, '');
  const localNumber = digits.startsWith('233') ? `0${digits.slice(3)}` : digits;
  return /^0\d{9}$/.test(localNumber) ? localNumber : null;
}

export const driverOperations = router({
  getPreferences: publicProcedure.input(driverIdInput).query(async ({ input }) => {
    const p = await profile(input.driverId);
    const preferences = p?.driver_preferences || {};
    const destination = preferences.destination || p?.destination_filter || null;
    return { preferences: {
      rideCategories: preferences.rideCategories || p?.ride_categories || ['standard'],
      pickupRadiusKm: preferences.pickupRadiusKm || p?.pickup_radius_km || 10,
      autoAccept: Boolean(preferences.autoAccept ?? p?.auto_accept),
      longTripsOnly: Boolean(preferences.longTripsOnly ?? p?.long_trips_only),
      preferHighRated: Boolean(preferences.preferHighRated ?? p?.prefer_high_rated),
      destination,
      destinationUsesRemaining: Number(preferences.destinationUsesRemaining ?? 2),
    }};
  }),
  savePreferences: publicProcedure.input(z.object({ driverId: z.string().min(1), rideCategories: z.array(z.string()).min(1), pickupRadiusKm: z.number().min(1).max(100), autoAccept: z.boolean(), destination: z.object({ label: z.string().min(1), latitude: z.number(), longitude: z.number() }).optional() })).mutation(async ({ input }) => {
    const p = await profile(input.driverId);
    const previous = p?.driver_preferences || {};
    let uses = Number(previous.destinationUsesRemaining ?? 2);
    const old = previous.destination;
    if (input.destination && (!old || old.label !== input.destination.label || old.latitude !== input.destination.latitude || old.longitude !== input.destination.longitude)) uses = Math.max(0, uses - 1);
    const preferences = { ...previous, rideCategories: input.rideCategories, pickupRadiusKm: input.pickupRadiusKm, autoAccept: input.autoAccept, destination: input.destination || null, destinationUsesRemaining: uses };
    await adminFirestore.set(ADMIN_COLLECTIONS.DRIVER_PROFILES, input.driverId, { driver_preferences: preferences, ride_categories: input.rideCategories, pickup_radius_km: input.pickupRadiusKm, auto_accept: input.autoAccept });
    return { preferences, destinationUsesRemaining: uses };
  }),
  clearDestinationFilter: publicProcedure.input(driverIdInput).mutation(async ({ input }) => {
    const p = await profile(input.driverId);
    const preferences = { ...(p?.driver_preferences || {}), destination: null };
    await adminFirestore.set(ADMIN_COLLECTIONS.DRIVER_PROFILES, input.driverId, { driver_preferences: preferences, destination_filter: null });
    return { success: true, preferences };
  }),
  setAvailability: publicProcedure.input(z.object({ driverId: z.string().min(1), status: z.enum(['online', 'offline', 'busy']) })).mutation(async ({ input }) => {
    await setDriverProfilePresence(input.driverId, profilePresencePatch(input.status));
    return { success: true, status: input.status };
  }),
  updateLocation: publicProcedure.input(z.object({ driverId: z.string().min(1), latitude: z.number(), longitude: z.number(), heading: z.number().optional(), speedKmh: z.number().optional() })).mutation(async ({ input }) => {
    const location = { latitude: input.latitude, longitude: input.longitude, heading: input.heading ?? null, speedKmh: input.speedKmh ?? null, recorded_at: now() };
    const patch = { user_id: input.driverId, current_location: location, latitude: input.latitude, longitude: input.longitude, last_location_update: now() };
    // Keep every profile document for this UID in sync so an offline toggle on
    // the legacy approved profile cannot leave a stale UID marker visible.
    await setDriverProfilePresence(input.driverId, patch);
    void sendDriverLocationLiveActivityUpdates(input.driverId, { latitude: input.latitude, longitude: input.longitude }).catch((error) => {
      console.error('[LiveActivity] Foreground Driver location push failed:', error);
    });
    return { success: true, location };
  }),
});

export const driverTrips = router({
  history: publicProcedure.input(driverIdInput).query(async ({ input }) => {
    // History is read through the backend rather than a direct mobile Firestore
    // query. This avoids a client-side rules/index failure being displayed as an
    // empty trip list, while still limiting results to the signed-in Driver ID.
    const rides = await adminFirestore.list(
      ADMIN_COLLECTIONS.RIDES,
      { driver_id: input.driverId },
      null,
      'desc',
      500,
    );
    return {
      rides: rides.sort((left, right) => {
        const rightDate = new Date(String(right.completed_at || right.trip_date || right.created_date || 0)).getTime();
        const leftDate = new Date(String(left.completed_at || left.trip_date || left.created_date || 0)).getTime();
        return rightDate - leftDate;
      }),
    };
  }),
  rateRider: publicProcedure.input(z.object({
    driverId: z.string().min(1),
    rideId: z.string().min(1),
    riderId: z.string().min(1),
    rating: z.number().int().min(1).max(5),
    feedback: z.string().max(2000).optional(),
    foundItem: z.string().max(2000).optional(),
    safetyReport: z.string().max(2000).optional(),
  })).mutation(async ({ input }) => {
    const ride = await rideFor(input.driverId, input.rideId);
    const rideDriverId = String(ride.driver_id || ride.driverId || ride.driver?.id || '');
    const rideRiderId = String(ride.rider_id || ride.riderId || ride.rider?.id || '');
    if (rideDriverId !== input.driverId || rideRiderId !== input.riderId) throw new Error('This ride is not eligible for rating.');
    if (ride.status !== 'completed') throw new Error('Complete the ride before submitting a rating.');

    // This primary write is the rating submission itself. It must never be
    // blocked by a secondary, non-critical average-rating refresh.
    await adminFirestore.update(ADMIN_COLLECTIONS.RIDES, input.rideId, { driver_rating: input.rating, driver_feedback: input.feedback || '', driver_rated_at: now() });

    const warnings: string[] = [];
    try {
      // A Firestore `where(rider_id) + orderBy(completed_at)` query requires a
      // composite index. Ordering is irrelevant to an average, so read the
      // rider's completed rides without an order and calculate locally. This
      // keeps the flow compatible with existing production data.
      const riderRides = await adminFirestore.list(ADMIN_COLLECTIONS.RIDES, { rider_id: input.riderId }, null, 'desc', 500);
      const rated = riderRides
        .filter((item) => item.status === 'completed')
        .map((item) => Number(item.driver_rating || 0))
        .filter((value) => value > 0);
      const riderProfiles = await adminFirestore.list(ADMIN_COLLECTIONS.RIDER_PROFILES, { user_id: input.riderId }, null, 'desc', 5);
      const riderProfile = riderProfiles[0] || await adminFirestore.get(ADMIN_COLLECTIONS.RIDER_PROFILES, input.riderId);
      if (riderProfile && rated.length) {
        await adminFirestore.update(
          ADMIN_COLLECTIONS.RIDER_PROFILES,
          riderProfile.id,
          { rating: Number((rated.reduce((sum, value) => sum + value, 0) / rated.length).toFixed(2)), rating_count: rated.length },
        );
      }
    } catch (error) {
      // The ride record already has the driver's rating. Do not present an
      // optional aggregate-refresh failure as a failed submission.
      console.error('[Ratings] Rider average refresh failed after rating write:', error);
      warnings.push('rider_average_not_refreshed');
    }
    if (input.foundItem?.trim()) {
      try {
        await adminFirestore.create('found_items', { driver_id: input.driverId, ride_id: input.rideId, rider_id: input.riderId, description: input.foundItem.trim(), status: 'reported', reported_at: now() });
      } catch (error) {
        console.error('[Ratings] Found-item report failed after rating write:', error);
        warnings.push('found_item_not_recorded');
      }
    }
    if (input.safetyReport?.trim()) {
      try {
        await adminFirestore.create(ADMIN_COLLECTIONS.RIDE_REPORTS, { reporter_id: input.driverId, reporter_role: 'driver', ride_id: input.rideId, type: 'safety', description: input.safetyReport.trim(), status: 'open', created_at: now() });
      } catch (error) {
        console.error('[Ratings] Safety report failed after rating write:', error);
        warnings.push('safety_report_not_recorded');
      }
    }
    return { success: true, warnings };
  }),
  availableOffers: publicProcedure.input(driverIdInput).query(async ({ input }) => {
    const driverProfile = await profile(input.driverId);
    if (!driverProfile || !isOnline(driverProfile)) return { offers: [] };
    if (!(await hasCurrentPlatformFee(input.driverId))) return { offers: [] };

    const preferences = driverProfile.driver_preferences || {};
    const radiusKm = Number(preferences.pickupRadiusKm ?? driverProfile.pickup_radius_km ?? 10);
    const driverLocation = locationOf(driverProfile);
    if (!driverLocation) return { offers: [] };

    const recentRides = await adminFirestore.list(ADMIN_COLLECTIONS.RIDES, {}, 'created_at', 'desc', 40);
    const offers = recentRides
      .filter((ride) => ride.status === 'searching' && !ride.driver_id)
      .filter((ride) => !Array.isArray(ride.declined_by_driver_ids) || !ride.declined_by_driver_ids.includes(input.driverId))
      .filter((ride) => hasCategory(driverProfile, ride.category))
      .map((ride) => ({ ...ride, pickup_distance_km: pickupDistanceKm(ride, driverLocation) }))
      .filter((ride) => ride.pickup_distance_km !== null && ride.pickup_distance_km <= radiusKm)
      .sort((left, right) => Number(left.pickup_distance_km) - Number(right.pickup_distance_km))
      .slice(0, 5);
    return { offers };
  }),
  activateQueued: publicProcedure.input(z.object({ driverId: z.string(), rideId: z.string(), completedRideId: z.string().optional() })).mutation(async ({ input }) => {
    const ride = await rideFor(input.driverId, input.rideId);
    const updated = withRide(ride, { driver_id: input.driverId, status: 'driver_arriving', queued_after_ride_id: null, activated_at: now() });
    await adminFirestore.update(ADMIN_COLLECTIONS.RIDES, input.rideId, updated);
    await recordRideEvent({ rideId: input.rideId, type: 'queued_ride_activated', actorId: input.driverId, actorRole: 'driver', status: updated.status, metadata: { completed_ride_id: input.completedRideId || null } });
    return { success: true, ride: updated };
  }),
  respondToOffer: publicProcedure.input(z.object({ driverId: z.string(), rideId: z.string(), decision: z.enum(['accept', 'decline']), driverName: z.string().optional(), vehicle_make: z.string().optional(), vehicle_model: z.string().optional(), vehicle_plate: z.string().optional(), license_plate: z.string().optional(), vehicle_color: z.string().optional(), vehicle_colour: z.string().optional(), vehicle_colour_hex: z.string().optional(), vehicle_full_model: z.string().optional(), queueAfterRideId: z.string().optional() })).mutation(async ({ input }) => {
    const driverProfile = await profile(input.driverId);
    if (!driverProfile || !isOnline(driverProfile)) throw new Error('Go online in the Driver app before accepting a ride.');
    if (input.decision === 'accept' && !(await hasCurrentPlatformFee(input.driverId))) {
      throw new Error('Pay today’s platform fee before accepting ride requests.');
    }
    const ride = await rideFor(input.driverId, input.rideId);
    if (input.decision === 'decline') {
      const declined = Array.isArray(ride.declined_by_driver_ids) ? ride.declined_by_driver_ids : [];
      const updated = withRide(ride, {
        status: 'searching',
        driver_id: null,
        declined_by_driver_ids: [...new Set([...declined, input.driverId])],
      });
      await adminFirestore.update(ADMIN_COLLECTIONS.RIDES, input.rideId, updated);
      await recordRideEvent({ rideId: input.rideId, type: 'offer_declined', actorId: input.driverId, actorRole: 'driver', status: updated.status });
      return { success: true, ride: updated, decision: input.decision };
    }
    if (input.queueAfterRideId) {
      const currentRide = await rideFor(input.driverId, input.queueAfterRideId);
      if (currentRide.status !== 'in_progress') {
        throw new Error('A next ride can only be queued while the current trip is in progress.');
      }
      const alreadyQueued = await adminFirestore.list(
        ADMIN_COLLECTIONS.RIDES,
        { driver_id: input.driverId, status: 'driver_queued' },
        'accepted_at',
        'desc',
        2,
      );
      if (alreadyQueued.some((queued) => queued.id !== input.rideId)) {
        throw new Error('This driver already has a queued next ride.');
      }
    }
    const status = input.queueAfterRideId ? 'driver_queued' : 'driver_arriving';
    const vehicleMake = input.vehicle_make || driverProfile?.vehicle_make || '';
    const vehicleModel = input.vehicle_model || driverProfile?.vehicle_model || '';
    const vehiclePlate = input.vehicle_plate || input.license_plate || driverProfile?.vehicle_plate || driverProfile?.license_plate || '';
    const vehicleColour = input.vehicle_colour || input.vehicle_color || driverProfile?.vehicle_colour || driverProfile?.vehicle_color || '';
    const vehicleColourHex = input.vehicle_colour_hex || driverProfile?.vehicle_colour_hex || '';
    const acceptedAt = now();
    const isDirectMomoRide = ride.payment_method === 'mobile_money' || ride.payment === 'mobile_money';
    const momoNumber = isDirectMomoRide ? directMomoNumber(driverProfile.momo_number) : null;
    const driver = {
      id: input.driverId,
      name: input.driverName || driverProfile.full_name || driverProfile.name || 'HY3N Driver',
      phone: driverProfile.phone || driverProfile.phone_number || '',
      photo_url: driverProfile.avatar_url || driverProfile.photo_url || '',
      rating: Number(driverProfile.rating ?? 5),
      total_trips: Number(driverProfile.total_trips ?? 0),
      vehicle_make: vehicleMake,
      vehicle_model: vehicleModel,
      vehicle_colour: vehicleColour,
      vehicle_colour_hex: vehicleColourHex,
      plate: vehiclePlate,
      location: locationOf(driverProfile),
      momo_number: momoNumber,
      momo_network: momoNumber ? (driverProfile.momo_network || '') : '',
    };
    const patch = {
      driver,
      driver_name: driver.name,
      driver_vehicle: `${vehicleMake} ${vehicleModel}`.trim(),
      driver_vehicle_make: vehicleMake,
      driver_vehicle_model: vehicleModel,
      driver_plate: vehiclePlate,
      driver_colour: vehicleColour,
      driver_colour_hex: vehicleColourHex,
      driver_momo_number: momoNumber,
      driver_momo_network: momoNumber ? (driverProfile.momo_network || '') : null,
      status,
      accepted_at: acceptedAt,
      matched_at: acceptedAt,
      queued_after_ride_id: input.queueAfterRideId || null,
    };
    const updated = await adminFirestore.claimSearchingRide(input.rideId, input.driverId, patch);
    await recordRideEvent({ rideId: input.rideId, type: input.queueAfterRideId ? 'offer_queued' : 'offer_accepted', actorId: input.driverId, actorRole: 'driver', status, metadata: { queued_after_ride_id: input.queueAfterRideId || null } });
    publishLiveActivity(updated, true);
    return { success: true, ride: updated, decision: input.decision };
  }),
  arrive: publicProcedure.input(z.object({ driverId: z.string(), rideId: z.string() })).mutation(async ({ input }) => {
    const ride = await rideFor(input.driverId, input.rideId);
    const updated = withRide(ride, { driver_id: input.driverId, status: 'driver_arrived', driver_arrived_at: now() });
    await adminFirestore.update(ADMIN_COLLECTIONS.RIDES, input.rideId, updated);
    await recordRideEvent({ rideId: input.rideId, type: 'driver_arrived', actorId: input.driverId, actorRole: 'driver', status: updated.status });
    publishLiveActivity(updated, true);
    return { success: true, ride: updated };
  }),
  verifyPickup: publicProcedure.input(z.object({ driverId: z.string(), rideId: z.string(), pickupCode: z.string() })).mutation(async ({ input }) => {
    const ride = await rideFor(input.driverId, input.rideId);
    if (ride.pickup_code && String(ride.pickup_code) !== input.pickupCode.trim()) throw new Error('Invalid pickup code.');
    const updated = withRide(ride, { pickup_verified_at: now() });
    await adminFirestore.update(ADMIN_COLLECTIONS.RIDES, input.rideId, updated);
    await recordRideEvent({ rideId: input.rideId, type: 'pickup_verified', actorId: input.driverId, actorRole: 'driver', status: updated.status });
    return { success: true, ride: updated };
  }),
  start: publicProcedure.input(z.object({
    driverId: z.string(),
    rideId: z.string(),
    waitingTimeMinutes: z.number().optional(),
    waitingFee: z.number().optional(),
    startLocation: z.object({ latitude: z.number(), longitude: z.number() }).optional(),
  })).mutation(async ({ input }) => {
    const ride = await rideFor(input.driverId, input.rideId);
    if (!canStartTrip(ride)) throw new Error('Trip must be marked driver_arrived before it can start.');
    if (ride.pickup_code && !ride.pickup_verified_at) throw new Error('Pickup code must be verified before the trip can start.');
    const tripStartedAt = now();
    const tripMeter = initializeTripMeter(tripStartedAt, input.startLocation);
    const updated = withRide(ride, {
      driver_id: input.driverId,
      status: 'in_progress',
      trip_started_at: tripStartedAt,
      trip_meter: tripMeter,
      trip_distance_source: 'server_gps_meter',
      actual_distance_km: 0,
      waiting_time_minutes: input.waitingTimeMinutes || 0,
      waiting_fee: input.waitingFee || 0,
    });
    await adminFirestore.update(ADMIN_COLLECTIONS.RIDES, input.rideId, updated);
    await recordRideEvent({ rideId: input.rideId, type: 'trip_started', actorId: input.driverId, actorRole: 'driver', status: updated.status, metadata: { waiting_time_minutes: input.waitingTimeMinutes || 0 } });
    publishLiveActivity(updated, true);
    return { success: true, ride: updated };
  }),
  recordTripLocation: publicProcedure.input(z.object({
    driverId: z.string(),
    rideId: z.string(),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    recordedAt: z.string().datetime().optional(),
  })).mutation(async ({ input }) => {
    const ride = await rideFor(input.driverId, input.rideId);
    if (!canCompleteTrip(ride)) throw new Error('Trip GPS can only be recorded after Start Trip is confirmed.');
    const observedAt = input.recordedAt || now();
    const { meter, accepted, incrementKm, ignoredReason } = advanceTripMeter(
      ride.trip_meter,
      { latitude: input.latitude, longitude: input.longitude },
      observedAt,
    );
    const updated = withRide(ride, {
      trip_meter: meter,
      trip_distance_source: 'server_gps_meter',
      actual_distance_km: meter.distance_km,
      trip_last_location_at: observedAt,
    });
    await adminFirestore.update(ADMIN_COLLECTIONS.RIDES, input.rideId, updated);
    publishLiveActivity(updated);
    return { success: true, accepted, incrementKm, ignoredReason: ignoredReason || null, actualDistanceKm: meter.distance_km };
  }),
  complete: publicProcedure.input(z.object({ driverId: z.string(), rideId: z.string(), finalFare: z.number().nonnegative().optional(), tipAmount: z.number().nonnegative().optional(), actualDistanceKm: z.number().optional(), actualDurationMinutes: z.number().optional(), fareBreakdown: z.any().optional() })).mutation(async ({ input }) => {
    const ride = await rideFor(input.driverId, input.rideId);
    if (!canCompleteTrip(ride)) throw new Error('A trip cannot be completed or charged before Start Trip is confirmed.');
    const quotedFare = getQuotedRideFare(ride);
    const completedAt = now();
    const meteredDurationMinutes = getTripDurationMinutes(ride.trip_started_at, new Date(completedAt).getTime());
    const recordedMeterDistance = Number(ride.trip_meter?.distance_km);
    const hasServerMeteredDistance = Number(ride.trip_meter?.accepted_samples) > 0
      && Number.isFinite(recordedMeterDistance)
      && recordedMeterDistance >= 0;
    const compatibleDistance = getCappedCompatibilityDistanceKm(
      input.actualDistanceKm,
      ride.estimated_distance_km ?? ride.distance_km ?? ride.distance,
    );
    // Build 45 reports its locally tracked post-start distance at completion.
    // Newer builds submit each point through recordTripLocation. Neither path
    // can fall back to the booking route estimate when the Driver did not move.
    const actualDistanceKm = hasServerMeteredDistance
      ? recordedMeterDistance
      : (compatibleDistance ?? 0);
    const finalFare = getMeteredTripFare({
      category: ride.category,
      distanceKm: actualDistanceKm,
      durationMinutes: meteredDurationMinutes,
      waitingFee: ride.waiting_fee,
      surgeMultiplier: ride.surge_multiplier,
    });
    const meteredBreakdown = getMeteredFareBreakdown({
      category: ride.category,
      distanceKm: actualDistanceKm,
      durationMinutes: meteredDurationMinutes,
      waitingFee: ride.waiting_fee,
      surgeMultiplier: ride.surge_multiplier,
    });
    // Tips are a Rider-controlled post-trip action. Do not allow a Driver
    // completion request to add one to the amount charged or earned.
    const tip = 0;
    const updated = withRide(ride, {
      driver_id: input.driverId,
      status: 'completed',
      quoted_fare: quotedFare,
      fare_estimate: quotedFare,
      fare: finalFare,
      final_fare: finalFare,
      tip_amount: tip,
      driver_earnings: getTripChargeTotal({ ...ride, final_fare: finalFare, tip_amount: tip }),
      driver_reported_final_fare: input.finalFare ?? null,
      actual_distance_km: actualDistanceKm,
      actual_duration_minutes: meteredDurationMinutes,
      fare_authority: 'metered_trip',
      fare_breakdown: {
        ...meteredBreakdown,
        quotedFare,
        waitingFee: Number(ride.waiting_fee || 0),
        finalFare,
        authority: 'server_metered_distance_and_time',
        compatibility_distance_used: !hasServerMeteredDistance,
      },
      completed_at: completedAt,
    });
    await adminFirestore.update(ADMIN_COLLECTIONS.RIDES, input.rideId, updated);
    publishLiveActivity(updated, true);
    await recordRideEvent({
      rideId: input.rideId,
      type: 'trip_completed',
      actorId: input.driverId,
      actorRole: 'driver',
      status: updated.status,
      metadata: {
        final_fare: finalFare,
        actual_distance_km: actualDistanceKm,
        actual_duration_minutes: meteredDurationMinutes,
        fare_authority: 'server_metered_distance_and_time',
      },
    });

    // Send the receipt from the backend so it works even when the rider closes
    // the app immediately after the driver completes the trip. The rider app
    // keeps its local request as a fallback for older deployments.
    const riderEmail = await receiptEmailForRide(ride);
    if (riderEmail && !ride.receipt_email_sent) {
      const pickup = typeof ride.pickup === 'string' ? ride.pickup : ride.pickup?.name || ride.pickup_address || 'Pickup location';
      const destination = typeof ride.destination === 'string' ? ride.destination : ride.destination?.name || ride.destination_address || 'Destination';
      const sent = await sendTripReceiptEmail({
        riderEmail,
        riderName: ride.rider_name || ride.riderName || 'HY3N Rider',
        driverName: ride.driver_name || ride.driverName || 'Driver',
        driverVehicle: ride.driver_vehicle || ride.driverVehicle || 'HY3N vehicle',
        driverPlate: ride.driver_plate || ride.driverPlate || 'Not available',
        pickup,
        destination,
        fare: finalFare,
        paymentMethod: ride.payment_display_name || ride.payment_method || ride.payment || 'Cash',
        distance: actualDistanceKm,
        duration: meteredDurationMinutes,
        category: ride.category,
        tripId: input.rideId,
        completedAt,
      });
      await adminFirestore.update(ADMIN_COLLECTIONS.RIDES, input.rideId, sent
        ? {
            rider_email: riderEmail,
            receipt_email_sent: true,
            receipt_email_sent_at: now(),
            receipt_email_last_status: 'sent',
          }
        : {
            rider_email: riderEmail,
            receipt_email_last_status: 'failed',
            receipt_email_last_attempt_at: now(),
          });
    } else if (!riderEmail) {
      await adminFirestore.update(ADMIN_COLLECTIONS.RIDES, input.rideId, {
        receipt_email_last_status: 'missing_recipient_email',
        receipt_email_last_attempt_at: now(),
      });
    }

    return { success: true, ride: updated, driverEarnings: finalFare };
  }),
  cancel: publicProcedure.input(z.object({ driverId: z.string(), rideId: z.string(), reason: z.string() })).mutation(async ({ input }) => { const ride = await rideFor(input.driverId, input.rideId); const updated = withRide(ride, { status: 'cancelled', cancelled_by: 'driver', cancellation_reason: input.reason, cancelled_at: now() }); await adminFirestore.update(ADMIN_COLLECTIONS.RIDES, input.rideId, updated); return { success: true, ride: updated }; }),
});

export const driverSafety = router({
  createSos: publicProcedure.input(z.object({ driverId: z.string(), driverName: z.string().optional(), rideId: z.string().optional(), message: z.string().optional(), location: z.object({ latitude: z.number(), longitude: z.number() }).optional() })).mutation(async ({ input }) => ({ success: true, incident: await adminFirestore.create(ADMIN_COLLECTIONS.SOS_INCIDENTS, { ...input, status: 'open', source: 'driver_app' }) })),
  recordDrivingEvent: publicProcedure.input(z.object({ driverId: z.string(), rideId: z.string().optional(), type: z.string(), previousSpeedKmh: z.number().optional(), currentSpeedKmh: z.number().optional(), location: z.object({ latitude: z.number(), longitude: z.number() }).optional() })).mutation(async ({ input }) => ({ success: true, event: await adminFirestore.create('driver_safety_events', input) })),
  reportRoadHazard: publicProcedure.input(z.object({ driverId: z.string(), type: z.string(), description: z.string().optional(), latitude: z.number(), longitude: z.number() })).mutation(async ({ input }) => ({ success: true, hazard: await adminFirestore.create('road_hazards', { ...input, status: 'active', expires_at: new Date(Date.now() + 24 * 3600000).toISOString() }) })),
});

export const driverFinance = router({
  getOverview: publicProcedure
    .input(z.object({ driverId: z.string(), period: z.enum(['today', 'week', 'month']).optional() }))
    .query(async ({ input }) => {
      const period = input.period || 'week';
      // Do not combine `driver_id`, `status`, and `completed_at` in a Firestore
      // query. Older production projects do not have that composite index, and
      // a failed query was previously rendered by the app as GH₵0.00. Fetch the
      // Driver's own bounded ride history without an order requirement, then
      // apply completion, period filtering, and presentation sorting on the
      // trusted backend.
      const rides = await adminFirestore.list(
        ADMIN_COLLECTIONS.RIDES,
        { driver_id: input.driverId },
        null,
        'desc',
        500,
      );
      const completedRides = completedRidesForPeriod(rides, period);
      const gross = completedRides.reduce((sum, ride) => sum + numericRideFare(ride), 0);
      const tips = completedRides.reduce((sum, ride) => sum + numericTip(ride), 0);
      // `daily_commissions` has no driver_id/date composite index in
      // production. A no-order Driver-only read remains index-safe.
      const fees = await adminFirestore.list(ADMIN_COLLECTIONS.DAILY_COMMISSION, { driver_id: input.driverId }, null, 'desc', 100);
      const currentFee = await getDailyPlatformFee();
      const periodFees = paidFeesForPeriod(fees, period);
      const dailyPlatformFee = periodFees
        .reduce((sum, fee) => sum + Number(fee.amount ?? currentFee.amount), 0);
      const today = dateKey();
      const todayFee = fees.find((fee) => fee.date === today && ['paid', 'completed', 'processing'].includes(fee.status));
      const total = gross + tips;
      const savedGoal = await adminFirestore.get('driver_goals', `${input.driverId}_${period}`);
      const goal = savedGoal?.targetAmount
        ? {
            amount: Number(savedGoal.targetAmount),
            progress: total,
            percent: Math.min(100, Number((total / Number(savedGoal.targetAmount) * 100).toFixed(1))),
          }
        : null;

      return {
        totals: {
          gross,
          net: total - dailyPlatformFee,
          tips,
          dailyPlatformFee,
          dailyFeeDays: periodFees.length,
          tripCount: completedRides.length,
          averagePerTrip: completedRides.length ? total / completedRides.length : 0,
          availableBalance: total - dailyPlatformFee,
        },
        dailyFee: {
          amount: currentFee.amount,
          status: todayFee?.status === 'paid' || todayFee?.status === 'completed' ? 'paid' : 'unpaid',
          date: today,
        },
        trend: earningsTrend(completedRides),
        goals: [],
        goal,
        payoutMethod: (await profile(input.driverId))?.payout_method || null,
      };
    }),
  listIncentives: publicProcedure.input(driverIdInput).query(async () => ({ incentives: await adminFirestore.list('driver_incentives', { status: 'active' }, 'created_date', 'desc', 50) })),
  saveGoal: publicProcedure.input(z.object({ driverId: z.string(), period: z.enum(['today', 'week', 'month']), targetAmount: z.number().min(0) })).mutation(async ({ input }) => ({ success: true, goal: await adminFirestore.set('driver_goals', `${input.driverId}_${input.period}`, input) })),
  savePayoutMethod: publicProcedure.input(z.object({ driverId: z.string(), provider: z.string(), accountNumber: z.string(), accountHolder: z.string() })).mutation(async ({ input }) => { const digits = input.accountNumber.replace(/\D/g, ''); const method = { provider: input.provider, accountHolder: input.accountHolder, accountNumberMasked: `${digits.slice(0, 3)}****${digits.slice(-2)}`, updatedAt: now() }; await adminFirestore.set(ADMIN_COLLECTIONS.DRIVER_PROFILES, input.driverId, { payout_method: method, momo_provider: input.provider, momo_account_holder: input.accountHolder, momo_number_masked: method.accountNumberMasked }); return { success: true, payoutMethod: method }; }),
  requestPayout: publicProcedure.input(z.object({ driverId: z.string(), amount: z.number().min(10) })).mutation(async ({ input }) => { const request = await adminFirestore.create('driver_payouts', { ...input, status: 'pending', requested_at: now() }); return { success: true, request }; }),
});

export const driverPerformance = router({ getOverview: publicProcedure.input(driverIdInput).query(async ({ input }) => { const rides = await adminFirestore.list(ADMIN_COLLECTIONS.RIDES, { driver_id: input.driverId }, 'created_date', 'desc', 500); const completed = rides.filter(r => r.status === 'completed').length; const cancelled = rides.filter(r => r.cancelled_by === 'driver').length; const offered = rides.filter(r => r.driver_id === input.driverId).length; const ratings = rides.map(r => Number(r.driver_rating)).filter(n => Number.isFinite(n) && n > 0); return { metrics: { acceptanceRate: offered ? Number((completed / offered * 100).toFixed(1)) : 0, cancellationRate: rides.length ? Number((cancelled / rides.length * 100).toFixed(1)) : 0, rating: ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : 0, ratingsCount: ratings.length, completedTrips: completed } }; }) });

export const driverScheduling = router({
  listAvailable: publicProcedure.input(z.object({ driverId: z.string(), limit: z.number().optional() })).query(async ({ input }) => ({ rides: await adminFirestore.list(ADMIN_COLLECTIONS.SCHEDULED_RIDES, {}, 'scheduled_pickup_at', 'asc', input.limit || 30) })),
  reserve: publicProcedure.input(z.object({ driverId: z.string(), rideId: z.string(), driverName: z.string().optional() })).mutation(async ({ input }) => { const ride = await adminFirestore.get(ADMIN_COLLECTIONS.SCHEDULED_RIDES, input.rideId) || await adminFirestore.get(ADMIN_COLLECTIONS.RIDES, input.rideId); if (!ride) throw new Error('Scheduled ride not found.'); const updated = withRide(ride, { driver_id: input.driverId, driver_name: input.driverName, status: 'driver_scheduled' }); await adminFirestore.update(ride.collection || ADMIN_COLLECTIONS.SCHEDULED_RIDES, input.rideId, updated).catch(async () => { await adminFirestore.update(ADMIN_COLLECTIONS.RIDES, input.rideId, updated); }); return { success: true, ride: updated }; }),
  release: publicProcedure.input(z.object({ driverId: z.string(), rideId: z.string() })).mutation(async ({ input }) => { const ride = await adminFirestore.get(ADMIN_COLLECTIONS.SCHEDULED_RIDES, input.rideId) || await adminFirestore.get(ADMIN_COLLECTIONS.RIDES, input.rideId); if (!ride) throw new Error('Scheduled ride not found.'); const updated = withRide(ride, { driver_id: null, driver_name: null, status: 'scheduled' }); await adminFirestore.update(ADMIN_COLLECTIONS.SCHEDULED_RIDES, input.rideId, updated).catch(async () => { await adminFirestore.update(ADMIN_COLLECTIONS.RIDES, input.rideId, updated); }); return { success: true, ride: updated }; }),
});

export const driverSupport = router({
  listTickets: publicProcedure.input(driverIdInput).query(async ({ input }) => ({ tickets: await adminFirestore.list(ADMIN_COLLECTIONS.SUPPORT_TICKETS, { driver_id: input.driverId }, 'created_date', 'desc', 50) })),
  createTicket: publicProcedure.input(z.object({ driverId: z.string(), category: z.string(), subject: z.string().optional(), message: z.string().min(1) })).mutation(async ({ input }) => ({ success: true, ticket: await adminFirestore.create(ADMIN_COLLECTIONS.SUPPORT_TICKETS, { ...input, user_type: 'driver', status: 'open' }) })),
});

export const checkPaidToday = publicProcedure.input(driverIdInput).query(async ({ input }) => {
  const date = dateKey();
  const records = await adminFirestore.list(ADMIN_COLLECTIONS.DAILY_COMMISSION, { driver_id: input.driverId, date }, '', 'desc', 20);
  const paid = records.some((record) => record.status === 'paid' || record.status === 'completed');
  const fee = await getDailyPlatformFee();
  return { paid, isPaid: paid, status: paid ? 'paid' : 'unpaid', amount: fee.amount, date, record: records[0] || null };
});
