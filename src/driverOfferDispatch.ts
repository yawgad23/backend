import { ADMIN_COLLECTIONS, adminFirestore } from './firebaseAdmin';
import { driverOfferRecipients, sendDriverRideOfferPush, type DriverPresence } from './driverOfferPush';
import { hasCurrentPlatformFee } from './driverRouters';

/**
 * Chooses one current nearby candidate and persists that choice before sending
 * a wake-up. The database transition, not the push result or a client clock,
 * is the authority for who may accept the request.
 */
export async function dispatchNextDriverRideOffer(rideId: string) {
  const ride = await adminFirestore.get(ADMIN_COLLECTIONS.RIDES, rideId);
  if (!ride || String(ride.status || '').toLowerCase() !== 'searching' || ride.driver_id) {
    return { changed: false, dispatched: false, ride: null as Record<string, any> | null };
  }

  const presences = await adminFirestore.list('driver_presence', {}, null, 'desc', 500) as DriverPresence[];
  // Presence performs the cheap fresh-location/category/radius filter. The
  // final list then rechecks the protected platform-fee gate before the server
  // assigns the lease; a non-paying Driver must not consume a Rider's minute.
  const nearbyCandidates = driverOfferRecipients(ride, presences, Date.now(), 24);
  const eligibility = await Promise.all(nearbyCandidates.map(async (driverId) => ({
    driverId,
    eligible: await hasCurrentPlatformFee(driverId),
  })));
  const candidates = eligibility.filter((candidate) => candidate.eligible).map((candidate) => candidate.driverId);
  const transition = await adminFirestore.targetNextSearchingRideOffer(rideId, candidates);
  if (transition.dispatched && transition.ride) {
    await sendDriverRideOfferPush(rideId, transition.ride);
  }
  return transition;
}

/**
 * Bounded scheduler recovery. The normal create/update triggers act sooner;
 * this catches a Driver whose device never responds to its one-minute offer.
 */
export async function dispatchDueDriverRideOffers(limit = 80) {
  const rides = await adminFirestore.list(
    ADMIN_COLLECTIONS.RIDES,
    { status: 'searching' },
    'created_at',
    'desc',
    limit,
  );
  const results = await Promise.allSettled(rides.map((ride) => dispatchNextDriverRideOffer(String(ride.id))));
  return {
    inspected: rides.length,
    advanced: results.filter((result) => result.status === 'fulfilled' && result.value.changed).length,
    failures: results.filter((result) => result.status === 'rejected').length,
  };
}
