import { z } from 'zod';
import { publicProcedure, router } from './trpc';
import { adminFirestore, ADMIN_COLLECTIONS } from './firebaseAdmin';
import { sendTripReceiptEmail } from './email';

const now = () => new Date().toISOString();
const dateKey = () => now().slice(0, 10);
const driverIdInput = z.object({ driverId: z.string().min(1) });

async function profile(driverId: string) {
  return adminFirestore.get(ADMIN_COLLECTIONS.DRIVER_PROFILES, driverId);
}

async function rideFor(driverId: string, rideId: string) {
  const ride = await adminFirestore.get(ADMIN_COLLECTIONS.RIDES, rideId);
  if (!ride) throw new Error('Ride not found.');
  if (ride.driver_id && ride.driver_id !== driverId) throw new Error('This ride is assigned to another driver.');
  return ride;
}

function withRide(ride: Record<string, any>, patch: Record<string, any>) {
  return { ...ride, ...patch, updated_date: now() };
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
    await adminFirestore.set(ADMIN_COLLECTIONS.DRIVER_PROFILES, input.driverId, { availability_status: input.status, is_online: input.status === 'online', last_seen_at: now() });
    return { success: true, status: input.status };
  }),
  updateLocation: publicProcedure.input(z.object({ driverId: z.string().min(1), latitude: z.number(), longitude: z.number(), heading: z.number().optional(), speedKmh: z.number().optional() })).mutation(async ({ input }) => {
    const location = { latitude: input.latitude, longitude: input.longitude, heading: input.heading ?? null, speedKmh: input.speedKmh ?? null, recorded_at: now() };
    await adminFirestore.set(ADMIN_COLLECTIONS.DRIVER_PROFILES, input.driverId, { current_location: location, latitude: input.latitude, longitude: input.longitude, last_location_update: now() });
    return { success: true, location };
  }),
});

export const driverTrips = router({
  activateQueued: publicProcedure.input(z.object({ driverId: z.string(), rideId: z.string(), completedRideId: z.string().optional() })).mutation(async ({ input }) => {
    const ride = await rideFor(input.driverId, input.rideId);
    const updated = withRide(ride, { driver_id: input.driverId, status: 'driver_arriving', queued_after_ride_id: null, activated_at: now() });
    await adminFirestore.update(ADMIN_COLLECTIONS.RIDES, input.rideId, updated);
    return { success: true, ride: updated };
  }),
  respondToOffer: publicProcedure.input(z.object({ driverId: z.string(), rideId: z.string(), decision: z.enum(['accept', 'decline']), driverName: z.string().optional(), queueAfterRideId: z.string().optional() })).mutation(async ({ input }) => {
    const ride = await rideFor(input.driverId, input.rideId);
    if (input.decision === 'decline') { const updated = withRide(ride, { status: 'requested', driver_id: null, declined_by_driver_id: input.driverId }); await adminFirestore.update(ADMIN_COLLECTIONS.RIDES, input.rideId, updated); return { success: true, ride: updated, decision: input.decision }; }
    const status = input.queueAfterRideId ? 'driver_queued' : 'driver_arriving';
    const updated = withRide(ride, { driver_id: input.driverId, driver_name: input.driverName || ride.driver_name, status, accepted_at: now(), queued_after_ride_id: input.queueAfterRideId || null });
    await adminFirestore.update(ADMIN_COLLECTIONS.RIDES, input.rideId, updated);
    return { success: true, ride: updated, decision: input.decision };
  }),
  arrive: publicProcedure.input(z.object({ driverId: z.string(), rideId: z.string() })).mutation(async ({ input }) => { const ride = await rideFor(input.driverId, input.rideId); const updated = withRide(ride, { driver_id: input.driverId, status: 'driver_arriving', driver_arrived_at: now() }); await adminFirestore.update(ADMIN_COLLECTIONS.RIDES, input.rideId, updated); return { success: true, ride: updated }; }),
  verifyPickup: publicProcedure.input(z.object({ driverId: z.string(), rideId: z.string(), pickupCode: z.string() })).mutation(async ({ input }) => { const ride = await rideFor(input.driverId, input.rideId); if (ride.pickup_code && String(ride.pickup_code) !== input.pickupCode.trim()) throw new Error('Invalid pickup code.'); const updated = withRide(ride, { pickup_verified_at: now() }); await adminFirestore.update(ADMIN_COLLECTIONS.RIDES, input.rideId, updated); return { success: true, ride: updated }; }),
  start: publicProcedure.input(z.object({ driverId: z.string(), rideId: z.string(), waitingTimeMinutes: z.number().optional(), waitingFee: z.number().optional() })).mutation(async ({ input }) => { const ride = await rideFor(input.driverId, input.rideId); const updated = withRide(ride, { driver_id: input.driverId, status: 'in_progress', trip_started_at: now(), waiting_time_minutes: input.waitingTimeMinutes || 0, waiting_fee: input.waitingFee || 0 }); await adminFirestore.update(ADMIN_COLLECTIONS.RIDES, input.rideId, updated); return { success: true, ride: updated }; }),
  complete: publicProcedure.input(z.object({ driverId: z.string(), rideId: z.string(), finalFare: z.number().nonnegative(), tipAmount: z.number().nonnegative().optional(), actualDistanceKm: z.number().optional(), actualDurationMinutes: z.number().optional(), fareBreakdown: z.any().optional() })).mutation(async ({ input }) => {
    const ride = await rideFor(input.driverId, input.rideId);
    const tip = input.tipAmount || 0;
    const completedAt = now();
    const updated = withRide(ride, { driver_id: input.driverId, status: 'completed', final_fare: input.finalFare, fare: input.finalFare, tip_amount: tip, driver_earnings: input.finalFare + tip, actual_distance_km: input.actualDistanceKm, actual_duration_minutes: input.actualDurationMinutes, fare_breakdown: input.fareBreakdown, completed_at: completedAt });
    await adminFirestore.update(ADMIN_COLLECTIONS.RIDES, input.rideId, updated);

    // Send the receipt from the backend so it works even when the rider closes
    // the app immediately after the driver completes the trip. The rider app
    // keeps its local request as a fallback for older deployments.
    const riderEmail = String(ride.rider_email || ride.riderEmail || '').trim();
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
        fare: input.finalFare + tip,
        paymentMethod: ride.payment_method || ride.payment || 'Cash',
        distance: input.actualDistanceKm,
        duration: input.actualDurationMinutes,
        category: ride.category,
        tripId: input.rideId,
        completedAt,
      });
      if (sent) await adminFirestore.update(ADMIN_COLLECTIONS.RIDES, input.rideId, { receipt_email_sent: true, receipt_email_sent_at: now() });
    }

    return { success: true, ride: updated, driverEarnings: input.finalFare + tip };
  }),
  cancel: publicProcedure.input(z.object({ driverId: z.string(), rideId: z.string(), reason: z.string() })).mutation(async ({ input }) => { const ride = await rideFor(input.driverId, input.rideId); const updated = withRide(ride, { status: 'cancelled', cancelled_by: 'driver', cancellation_reason: input.reason, cancelled_at: now() }); await adminFirestore.update(ADMIN_COLLECTIONS.RIDES, input.rideId, updated); return { success: true, ride: updated }; }),
});

export const driverSafety = router({
  createSos: publicProcedure.input(z.object({ driverId: z.string(), driverName: z.string().optional(), rideId: z.string().optional(), message: z.string().optional(), location: z.object({ latitude: z.number(), longitude: z.number() }).optional() })).mutation(async ({ input }) => ({ success: true, incident: await adminFirestore.create(ADMIN_COLLECTIONS.SOS_INCIDENTS, { ...input, status: 'open', source: 'driver_app' }) })),
  recordDrivingEvent: publicProcedure.input(z.object({ driverId: z.string(), rideId: z.string().optional(), type: z.string(), previousSpeedKmh: z.number().optional(), currentSpeedKmh: z.number().optional(), location: z.object({ latitude: z.number(), longitude: z.number() }).optional() })).mutation(async ({ input }) => ({ success: true, event: await adminFirestore.create('driver_safety_events', input) })),
  reportRoadHazard: publicProcedure.input(z.object({ driverId: z.string(), type: z.string(), description: z.string().optional(), latitude: z.number(), longitude: z.number() })).mutation(async ({ input }) => ({ success: true, hazard: await adminFirestore.create('road_hazards', { ...input, status: 'active', expires_at: new Date(Date.now() + 24 * 3600000).toISOString() }) })),
});

export const driverFinance = router({
  getOverview: publicProcedure.input(z.object({ driverId: z.string(), period: z.enum(['today', 'week', 'month']).optional() })).query(async ({ input }) => { const rides = await adminFirestore.list(ADMIN_COLLECTIONS.RIDES, { driver_id: input.driverId, status: 'completed' }, 'completed_at', 'desc', 500); const gross = rides.reduce((s, r) => s + Number(r.final_fare ?? r.fare ?? r.fare_estimate ?? 0), 0); const tips = rides.reduce((s, r) => s + Number(r.tip_amount || 0), 0); const fees = await adminFirestore.list(ADMIN_COLLECTIONS.DAILY_COMMISSION, { driver_id: input.driverId }, 'date', 'desc', 100); const dailyPlatformFee = fees.filter(f => f.status === 'paid' || f.status === 'completed').reduce((s, f) => s + Number(f.amount || 50), 0); const today = dateKey(); const todayFee = fees.find(f => f.date === today && ['paid', 'completed', 'processing'].includes(f.status)); const total = gross + tips; const savedGoal = await adminFirestore.get('driver_goals', `${input.driverId}_${input.period || 'week'}`); const goal = savedGoal?.targetAmount ? { amount: Number(savedGoal.targetAmount), progress: total, percent: Math.min(100, Number((total / Number(savedGoal.targetAmount) * 100).toFixed(1))) } : null; return { totals: { gross, net: total - dailyPlatformFee, tips, dailyPlatformFee, dailyFeeDays: fees.length, tripCount: rides.length, averagePerTrip: rides.length ? total / rides.length : 0, availableBalance: total - dailyPlatformFee }, dailyFee: { amount: 50, status: todayFee?.status === 'paid' || todayFee?.status === 'completed' ? 'paid' : 'unpaid', date: today }, trend: rides.slice(0, 14).map(r => ({ date: String(r.completed_at || r.created_date).slice(0, 10), amount: Number(r.final_fare ?? r.fare ?? 0) })), goals: [], goal, payoutMethod: (await profile(input.driverId))?.payout_method || null }; }),
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

export const checkPaidToday = publicProcedure.input(driverIdInput).query(async ({ input }) => { const date = dateKey(); const records = await adminFirestore.list(ADMIN_COLLECTIONS.DAILY_COMMISSION, { driver_id: input.driverId, date }, '', 'desc', 20); const paid = records.some(r => r.status === 'paid' || r.status === 'completed'); return { paid, isPaid: paid, status: paid ? 'paid' : 'unpaid', amount: 50, date, record: records[0] || null }; });
