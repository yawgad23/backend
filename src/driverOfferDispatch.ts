import { ADMIN_COLLECTIONS, adminFirestore, getAdminDb } from './firebaseAdmin';
import { driverOfferRecipients, sendDriverRideOfferPush, type DriverPresence } from './driverOfferPush';
import { driverCanServeRideCategory, hasCurrentPlatformFee } from './driverRouters';
import { driverProfileForUserId, isApprovedDriverProfile } from './driverApproval';
import { driverProfileInTransaction, isOnlineWithFreshLocation } from './driverPresence';
import { expiredRideSearchPatch, isRideSearchExpired } from './rideSearchExpiry';
import { excludedDriverIdsForOffer, nextDriverOfferPatch, shouldDispatchDriverOffer, waitingForDriverOfferPatch } from './rideOfferLifecycle';

/**
 * Chooses one current nearby candidate and persists that choice before sending
 * a wake-up. Application authority is rechecked inside the lease transaction,
 * so a concurrent manual rejection cannot be followed by a new offer lease.
 */
export async function dispatchNextDriverRideOffer(rideId: string) {
  const ride = await adminFirestore.get(ADMIN_COLLECTIONS.RIDES, rideId);
  if (!ride || String(ride.status || '').toLowerCase() !== 'searching' || ride.driver_id) {
    return { changed: false, dispatched: false, ride: null as Record<string, any> | null };
  }

  const presences = await adminFirestore.list('driver_presence', {}, null, 'desc', 500) as DriverPresence[];
  const nearbyCandidates = driverOfferRecipients(ride, presences, Date.now(), 24);
  const eligibility = await Promise.all(nearbyCandidates.map(async (driverId) => {
    const profile = await driverProfileForUserId(driverId);
    return {
      driverId,
      profile,
      eligible: isApprovedDriverProfile(profile)
        && driverCanServeRideCategory(profile, ride.category)
        && await hasCurrentPlatformFee(driverId, profile),
    };
  }));
  const candidates = eligibility.filter((candidate) => candidate.eligible);
  const db = getAdminDb();
  const rideRef = db.collection(ADMIN_COLLECTIONS.RIDES).doc(rideId);
  const transition = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(rideRef);
    if (!snapshot.exists) return { changed: false, dispatched: false, ride: null as Record<string, any> | null };
    const currentRide = { id: snapshot.id, ...snapshot.data() } as Record<string, any>;
    if (String(currentRide.status || '').toLowerCase() !== 'searching' || currentRide.driver_id) {
      return { changed: false, dispatched: false, ride: currentRide };
    }
    if (isRideSearchExpired(currentRide)) {
      const patch = expiredRideSearchPatch();
      transaction.update(rideRef, patch);
      return { changed: true, dispatched: false, ride: { ...currentRide, ...patch } };
    }
    if (!shouldDispatchDriverOffer(currentRide)) {
      return { changed: false, dispatched: false, ride: currentRide };
    }

    const excluded = new Set(excludedDriverIdsForOffer(currentRide));
    let nextDriverId: string | null = null;
    for (const candidate of candidates) {
      if (excluded.has(candidate.driverId)) continue;
      const currentProfile = await driverProfileInTransaction(transaction, candidate.driverId);
      const presenceSnapshot = await transaction.get(db.collection('driver_presence').doc(candidate.driverId));
      const currentPresence = presenceSnapshot.exists ? presenceSnapshot.data() : null;
      if (isApprovedDriverProfile(currentProfile)
        && driverCanServeRideCategory(currentProfile, currentRide.category)
        && isOnlineWithFreshLocation(currentPresence)
        && driverOfferRecipients(currentRide, [{ ...currentPresence, id: candidate.driverId, user_id: candidate.driverId }], Date.now()).includes(candidate.driverId)) {
        nextDriverId = candidate.driverId;
        break;
      }
    }
    const patch = nextDriverId
      ? nextDriverOfferPatch(currentRide, nextDriverId)
      : waitingForDriverOfferPatch(currentRide);
    transaction.update(rideRef, patch);
    return { changed: true, dispatched: Boolean(nextDriverId), ride: { ...currentRide, ...patch } };
  });
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
