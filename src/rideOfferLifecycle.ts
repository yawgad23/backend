import { isRideSearchExpired, rideSearchExpiresAt } from './rideSearchExpiry';

/** One Driver has one minute to accept or decline a targeted ride offer. */
export const DRIVER_OFFER_RESPONSE_MS = 60 * 1000;
/** Scheduler fallback checks open searches when a targeted device is offline. */
export const DRIVER_OFFER_RETRY_MS = 60 * 1000;

type RideRecord = Record<string, any>;

function text(value: unknown): string {
  return String(value || '').trim();
}

function timestampMs(value: unknown): number | null {
  if (typeof value === 'string' || typeof value === 'number' || value instanceof Date) {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (!value || typeof value !== 'object') return null;
  const timestamp = value as { toMillis?: () => number; seconds?: number; _seconds?: number; nanoseconds?: number; _nanoseconds?: number };
  if (typeof timestamp.toMillis === 'function') {
    const parsed = timestamp.toMillis();
    return Number.isFinite(parsed) ? parsed : null;
  }
  const seconds = Number(timestamp.seconds ?? timestamp._seconds);
  if (!Number.isFinite(seconds)) return null;
  const nanos = Number(timestamp.nanoseconds ?? timestamp._nanoseconds ?? 0);
  return seconds * 1000 + (Number.isFinite(nanos) ? nanos / 1_000_000 : 0);
}

function uniqueIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(text).filter(Boolean))];
}

function currentOfferDriverId(ride: RideRecord): string {
  return text(ride.offered_driver_id);
}

export function driverOfferExpiresAt(ride: RideRecord): number | null {
  return timestampMs(ride.driver_offer_expires_at);
}

export function currentDriverOfferAttempt(ride: RideRecord): number {
  const attempt = Math.floor(Number(ride.driver_offer_attempt));
  return Number.isFinite(attempt) && attempt > 0 ? attempt : 0;
}

/**
 * A targeted offer is current only while the ride remains unassigned, searching,
 * and inside the server-written offer deadline. A client clock never decides it.
 */
export function isCurrentDriverOffer(ride: RideRecord, currentTime = Date.now()): boolean {
  if (text(ride.status).toLowerCase() !== 'searching' || text(ride.driver_id)) return false;
  const expiresAt = driverOfferExpiresAt(ride);
  return Boolean(currentOfferDriverId(ride))
    && expiresAt !== null
    && currentTime < expiresAt
    && !isRideSearchExpired(ride, currentTime);
}

/**
 * Reads the authorisation boundary for an individual Driver offer. Legacy rides
 * without a server-issued offer state retain their old open-search behaviour
 * only until the reconciliation scheduler targets them after deployment.
 */
export function driverCanReviewOffer(ride: RideRecord, driverId: string, currentTime = Date.now()): boolean {
  const requestedDriverId = text(driverId);
  if (!requestedDriverId || text(ride.status).toLowerCase() !== 'searching' || text(ride.driver_id)) return false;
  if (isRideSearchExpired(ride, currentTime)) return false;

  const targetedDriverId = currentOfferDriverId(ride);
  const hasTargetedOfferState = Boolean(targetedDriverId || currentDriverOfferAttempt(ride) > 0);
  if (!hasTargetedOfferState) return true;

  return targetedDriverId === requestedDriverId && isCurrentDriverOffer(ride, currentTime);
}

/** Every prior targeted or explicitly declining Driver is skipped on the same Rider request. */
export function excludedDriverIdsForOffer(ride: RideRecord): string[] {
  return [...new Set([
    ...uniqueIds(ride.declined_by_driver_ids),
    ...uniqueIds(ride.offered_to_driver_ids),
    currentOfferDriverId(ride),
  ].filter(Boolean))];
}

/**
 * Selects the server-written fields for the next single Driver offer. The
 * overall Rider search deadline is retained; an offer can never outlive it.
 */
export function nextDriverOfferPatch(ride: RideRecord, driverId: string, currentTime = new Date()): Record<string, unknown> {
  const driver = text(driverId);
  if (!driver) throw new Error('A Driver ID is required for a targeted offer.');
  const nowMs = currentTime.getTime();
  const searchExpiry = rideSearchExpiresAt(ride);
  const expiresAtMs = Math.min(nowMs + DRIVER_OFFER_RESPONSE_MS, searchExpiry ?? nowMs + DRIVER_OFFER_RESPONSE_MS);
  if (expiresAtMs <= nowMs) throw new Error('This ride search has expired.');

  const attempted = [...new Set([...excludedDriverIdsForOffer(ride), driver])];
  return {
    offered_driver_id: driver,
    offered_to_driver_ids: attempted,
    driver_offer_attempt: currentDriverOfferAttempt(ride) + 1,
    driver_offer_status: 'pending',
    driver_offer_issued_at: currentTime.toISOString(),
    driver_offer_expires_at: new Date(expiresAtMs).toISOString(),
    driver_offer_retry_at: null,
    updated_date: currentTime.toISOString(),
  };
}

/** Marks an open search as waiting for another eligible Driver without cancelling the Rider request. */
export function waitingForDriverOfferPatch(ride: RideRecord, currentTime = new Date()): Record<string, unknown> {
  const searchExpiry = rideSearchExpiresAt(ride);
  const nowMs = currentTime.getTime();
  const retryAtMs = Math.min(nowMs + DRIVER_OFFER_RETRY_MS, searchExpiry ?? nowMs + DRIVER_OFFER_RETRY_MS);
  return {
    offered_driver_id: null,
    driver_offer_status: 'waiting_for_eligible_driver',
    driver_offer_expires_at: null,
    driver_offer_retry_at: new Date(retryAtMs).toISOString(),
    updated_date: currentTime.toISOString(),
  };
}

/** A Driver's explicit decline is preserved so the same request is not sent back to them. */
export function declinedDriverOfferPatch(ride: RideRecord, driverId: string, currentTime = new Date()): Record<string, unknown> {
  const declined = [...new Set([...uniqueIds(ride.declined_by_driver_ids), text(driverId)].filter(Boolean))];
  return {
    ...waitingForDriverOfferPatch(ride, currentTime),
    declined_by_driver_ids: declined,
    driver_offer_status: 'declined',
    // A Firestore update trigger may select the next eligible Driver now. Only
    // a no-candidate result uses the delayed retry backoff.
    driver_offer_retry_at: currentTime.toISOString(),
    last_driver_offer_declined_at: currentTime.toISOString(),
  };
}

/** Determines whether the scheduler or an expired Driver poll should advance an open search. */
export function shouldDispatchDriverOffer(ride: RideRecord, currentTime = Date.now()): boolean {
  if (text(ride.status).toLowerCase() !== 'searching' || text(ride.driver_id)) return false;
  if (isRideSearchExpired(ride, currentTime)) return false;
  if (isCurrentDriverOffer(ride, currentTime)) return false;
  const retryAt = timestampMs(ride.driver_offer_retry_at);
  return retryAt === null || currentTime >= retryAt;
}
