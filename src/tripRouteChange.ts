import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { ADMIN_COLLECTIONS, getAdminAuth, getAdminDb } from './firebaseAdmin';
import { driverProfileForUserId } from './driverApproval';
import { getMeteredFareBreakdown, getTripDurationMinutes } from './fareAuthority';
import { fetchRoadRouteWithStops } from './liveRouteMetrics';
import { sendDriverTripRouteChangePush } from './pushNotifications';

export type TripRouteChangeKind = 'destination' | 'add_stop';
export type TripRouteChangeDecision = 'accept' | 'decline';

export type TripRouteChangeQuote = {
  id: string;
  status: 'quoted';
  kind: TripRouteChangeKind;
  location: TripRouteLocation;
  estimated_total: number;
  estimated_remaining_distance_km: number;
  estimated_remaining_duration_minutes: number;
  estimated_total_distance_km: number;
  estimated_total_duration_minutes: number;
  created_at: string;
  expires_at: string;
};

const ROUTE_CHANGE_QUOTE_TTL_MS = 5 * 60_000;

export type TripRouteLocation = {
  name: string;
  address: string;
  lat: number;
  lng: number;
};

type RideRecord = Record<string, any>;

type PendingStop = TripRouteLocation & {
  id: string;
  status: 'pending' | 'completed';
  requested_at?: string;
  completed_at?: string;
};

export class TripRouteChangeError extends Error {
  constructor(message: string, public readonly statusCode = 400) {
    super(message);
    this.name = 'TripRouteChangeError';
  }
}

function text(value: unknown, fallback = '', maxLength = 300) {
  const normalized = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return normalized ? normalized.slice(0, maxLength) : fallback;
}

function finiteCoordinate(value: unknown, maximum: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && Math.abs(parsed) <= maximum ? parsed : null;
}

function riderIdForRide(ride: RideRecord) {
  return String(ride.rider_id || ride.riderId || ride.rider?.id || '').trim();
}

function driverIdForRide(ride: RideRecord) {
  return String(ride.driver_id || ride.driverId || ride.driver?.id || '').trim();
}

function isInProgress(ride: RideRecord) {
  return String(ride.status || '').trim().toLowerCase() === 'in_progress';
}

function requestStatus(ride: RideRecord) {
  return String(ride.route_change_request?.status || '').trim().toLowerCase();
}

function safeLocation(value: unknown): TripRouteLocation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const lat = finiteCoordinate(input.lat ?? input.latitude, 90);
  const lng = finiteCoordinate(input.lng ?? input.longitude, 180);
  const name = text(input.name ?? input.address, '', 160);
  const address = text(input.address ?? input.name, name, 300);
  if (lat === null || lng === null || !name || !address) return null;
  return { name, address, lat, lng };
}

/** Normalizes the only location data accepted for an in-progress route change. */
export function normalizeTripRouteLocation(value: unknown): TripRouteLocation {
  const location = safeLocation(value);
  if (!location) throw new TripRouteChangeError('Choose a valid address before requesting a route change.');
  return location;
}

function readPendingStops(ride: RideRecord): PendingStop[] {
  if (!Array.isArray(ride.in_trip_stops)) return [];
  return ride.in_trip_stops
    .map((candidate) => {
      const location = safeLocation(candidate);
      const source = candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : {};
      const id = text(source.id, '', 160);
      const status = String(source.status || 'pending').toLowerCase() === 'completed' ? 'completed' : 'pending';
      return location && id
        ? {
            ...location,
            id,
            status,
            ...(text(source.requested_at) ? { requested_at: text(source.requested_at) } : {}),
            ...(text(source.completed_at) ? { completed_at: text(source.completed_at) } : {}),
          }
        : null;
    })
    .filter((stop): stop is PendingStop => Boolean(stop));
}

function destinationLocation(ride: RideRecord): TripRouteLocation {
  const destination = safeLocation(ride.destination);
  if (!destination) throw new TripRouteChangeError('This trip does not have a valid destination.', 409);
  return destination;
}

function routeTargetFor(ride: RideRecord, stops = readPendingStops(ride), destination = destinationLocation(ride)) {
  const nextStop = stops.find((stop) => stop.status === 'pending');
  if (nextStop) {
    return {
      kind: 'stop' as const,
      stop_id: nextStop.id,
      location: { name: nextStop.name, address: nextStop.address, lat: nextStop.lat, lng: nextStop.lng },
    };
  }
  return { kind: 'destination' as const, location: destination };
}

function driverPoint(profile: RideRecord | null): { latitude: number; longitude: number } | null {
  const source = profile?.current_location && typeof profile.current_location === 'object'
    ? profile.current_location
    : profile;
  const latitude = finiteCoordinate(source?.latitude ?? source?.lat, 90);
  const longitude = finiteCoordinate(source?.longitude ?? source?.lng, 180);
  return latitude === null || longitude === null ? null : { latitude, longitude };
}

function quoteFromRide(ride: RideRecord): TripRouteChangeQuote | null {
  const quote = ride.route_change_quote && typeof ride.route_change_quote === 'object'
    ? ride.route_change_quote as RideRecord
    : null;
  const id = text(quote?.id, '', 160);
  const kind = quote?.kind === 'destination' || quote?.kind === 'add_stop' ? quote.kind : null;
  const location = safeLocation(quote?.location);
  const expiresAt = text(quote?.expires_at);
  const estimatedTotal = Number(quote?.estimated_total);
  if (!quote || quote.status !== 'quoted' || !id || !kind || !location || !expiresAt || !Number.isFinite(estimatedTotal)) return null;
  return {
    id,
    status: 'quoted',
    kind,
    location,
    estimated_total: estimatedTotal,
    estimated_remaining_distance_km: Number(quote.estimated_remaining_distance_km || 0),
    estimated_remaining_duration_minutes: Number(quote.estimated_remaining_duration_minutes || 0),
    estimated_total_distance_km: Number(quote.estimated_total_distance_km || 0),
    estimated_total_duration_minutes: Number(quote.estimated_total_duration_minutes || 0),
    created_at: text(quote.created_at),
    expires_at: expiresAt,
  };
}

/**
 * Calculates a display-only estimated final fare from the active server trip
 * meter plus the proposed server-road route. The Rider cannot supply a fare,
 * distance, duration, rate, or traffic result; the final charge remains the
 * server GPS meter at trip completion.
 */
export async function buildTripRouteChangeQuote(input: {
  ride: RideRecord;
  riderId: string;
  kind: TripRouteChangeKind;
  location: TripRouteLocation;
  driverProfile: RideRecord | null;
  nowMs?: number;
}): Promise<TripRouteChangeQuote> {
  if (riderIdForRide(input.ride) !== input.riderId) {
    throw new TripRouteChangeError('This trip does not belong to the signed-in Rider.', 403);
  }
  if (!isInProgress(input.ride)) {
    throw new TripRouteChangeError('Route changes can be requested only after the trip has started.', 409);
  }
  if (requestStatus(input.ride) === 'pending') {
    throw new TripRouteChangeError('Your Driver is already reviewing a route change.', 409);
  }
  const driverLocation = driverPoint(input.driverProfile);
  if (!driverLocation) {
    throw new TripRouteChangeError('Waiting for your Driver’s live location before calculating the new fare.', 409);
  }

  const destination = input.kind === 'destination' ? input.location : destinationLocation(input.ride);
  const pendingStops = readPendingStops(input.ride);
  const proposedStops = input.kind === 'add_stop'
    ? [...pendingStops.filter((stop) => stop.status === 'pending').map(({ id: _id, status: _status, requested_at: _requestedAt, completed_at: _completedAt, ...location }) => location), input.location]
    : pendingStops.filter((stop) => stop.status === 'pending').map(({ id: _id, status: _status, requested_at: _requestedAt, completed_at: _completedAt, ...location }) => location);
  const roadRoute = await fetchRoadRouteWithStops(
    driverLocation,
    [...proposedStops, destination].map((location) => ({ latitude: location.lat, longitude: location.lng })),
  );
  if (!roadRoute) {
    throw new TripRouteChangeError('Route guidance is temporarily unavailable. Please try again before asking your Driver.', 503);
  }

  const nowMs = input.nowMs ?? Date.now();
  const meteredDistanceKm = Math.max(0, Number(input.ride.trip_meter?.distance_km ?? input.ride.actual_distance_km ?? 0) || 0);
  const elapsedMinutes = getTripDurationMinutes(input.ride.trip_started_at, nowMs);
  const estimatedDistanceKm = meteredDistanceKm + roadRoute.distanceKm;
  const estimatedDurationMinutes = elapsedMinutes + roadRoute.durationMinutes;
  const fare = getMeteredFareBreakdown({
    category: input.ride.category,
    distanceKm: estimatedDistanceKm,
    durationMinutes: estimatedDurationMinutes,
    waitingFee: input.ride.waiting_fee,
    surgeMultiplier: input.ride.surge_multiplier,
    fareRate: input.ride.fare_rate_snapshot,
  });
  const createdAt = new Date(nowMs).toISOString();
  return {
    id: randomUUID(),
    status: 'quoted',
    kind: input.kind,
    location: input.location,
    estimated_total: fare.total,
    estimated_remaining_distance_km: Number(roadRoute.distanceKm.toFixed(3)),
    estimated_remaining_duration_minutes: Number(roadRoute.durationMinutes.toFixed(1)),
    estimated_total_distance_km: Number(estimatedDistanceKm.toFixed(3)),
    estimated_total_duration_minutes: Number(estimatedDurationMinutes.toFixed(1)),
    created_at: createdAt,
    expires_at: new Date(nowMs + ROUTE_CHANGE_QUOTE_TTL_MS).toISOString(),
  };
}

/** Builds a pending request without modifying fare, wallet, or ride status. */
export function pendingTripRouteChangePatch(input: {
  ride: RideRecord;
  riderId: string;
  kind: TripRouteChangeKind;
  location: TripRouteLocation;
  quoteId: string;
  requestId?: string;
  requestedAt?: string;
}): Record<string, unknown> {
  if (riderIdForRide(input.ride) !== input.riderId) {
    throw new TripRouteChangeError('This trip does not belong to the signed-in Rider.', 403);
  }
  if (!isInProgress(input.ride)) {
    throw new TripRouteChangeError('Route changes can be requested only after the trip has started.', 409);
  }
  if (requestStatus(input.ride) === 'pending') {
    throw new TripRouteChangeError('Your Driver is already reviewing a route change.', 409);
  }
  const quote = quoteFromRide(input.ride);
  if (!quote || quote.id !== input.quoteId || quote.kind !== input.kind || new Date(quote.expires_at).getTime() <= Date.now()) {
    throw new TripRouteChangeError('The estimated fare has expired. Please review the updated fare again.', 409);
  }
  if (quote.location.lat !== input.location.lat || quote.location.lng !== input.location.lng || quote.location.name !== input.location.name || quote.location.address !== input.location.address) {
    throw new TripRouteChangeError('This route does not match the fare you reviewed. Please calculate it again.', 409);
  }

  const requestedAt = input.requestedAt || new Date().toISOString();
  return {
    route_change_request: {
      id: input.requestId || randomUUID(),
      status: 'pending',
      kind: input.kind,
      location: input.location,
      quote: {
        id: quote.id,
        estimated_total: quote.estimated_total,
        estimated_remaining_distance_km: quote.estimated_remaining_distance_km,
        estimated_remaining_duration_minutes: quote.estimated_remaining_duration_minutes,
        expires_at: quote.expires_at,
      },
      rider_id: input.riderId,
      requested_at: requestedAt,
    },
    route_change_quote: null,
    route_change_updated_at: requestedAt,
  };
}

/** Applies a Driver decision. Only acceptance changes the Rider-visible route target. */
export function reviewTripRouteChangePatch(input: {
  ride: RideRecord;
  driverId: string;
  decision: TripRouteChangeDecision;
  reviewedAt?: string;
}): Record<string, unknown> {
  if (driverIdForRide(input.ride) !== input.driverId) {
    throw new TripRouteChangeError('This trip is not assigned to the signed-in Driver.', 403);
  }
  if (!isInProgress(input.ride)) {
    throw new TripRouteChangeError('Route changes can be reviewed only while this trip is in progress.', 409);
  }

  const request = input.ride.route_change_request && typeof input.ride.route_change_request === 'object'
    ? input.ride.route_change_request as RideRecord
    : null;
  const kind = request?.kind === 'destination' || request?.kind === 'add_stop' ? request.kind : null;
  const location = safeLocation(request?.location);
  const requestId = text(request?.id, '', 160);
  if (!request || requestStatus(input.ride) !== 'pending' || !kind || !location || !requestId) {
    throw new TripRouteChangeError('There is no valid pending route change to review.', 409);
  }

  const reviewedAt = input.reviewedAt || new Date().toISOString();
  const reviewedRequest = {
    ...request,
    status: input.decision === 'accept' ? 'accepted' : 'declined',
    reviewed_by: input.driverId,
    reviewed_at: reviewedAt,
  };

  if (input.decision === 'decline') {
    return {
      route_change_request: reviewedRequest,
      route_change_updated_at: reviewedAt,
    };
  }

  if (kind === 'destination') {
    const destination = location;
    const existingStops = readPendingStops(input.ride);
    return {
      route_change_request: { ...reviewedRequest, applied_at: reviewedAt },
      destination,
      destination_address: destination.address,
      destination_lat: destination.lat,
      destination_lng: destination.lng,
      route_target: routeTargetFor({ ...input.ride, destination }, existingStops, destination),
      live_route_metrics: null,
      route_change_updated_at: reviewedAt,
    };
  }

  const existingStops = readPendingStops(input.ride);
  if (existingStops.filter((stop) => stop.status === 'pending').length >= 3) {
    throw new TripRouteChangeError('This trip already has the maximum number of pending stops.', 409);
  }
  const stops = [...existingStops, { ...location, id: requestId, status: 'pending' as const, requested_at: reviewedAt }];
  return {
    route_change_request: { ...reviewedRequest, applied_at: reviewedAt },
    in_trip_stops: stops,
    route_target: routeTargetFor(input.ride, stops),
    live_route_metrics: null,
    route_change_updated_at: reviewedAt,
  };
}

/** Advances only a Driver-confirmed stop to the next stop or final destination. */
export function completeActiveTripStopPatch(input: { ride: RideRecord; driverId: string; completedAt?: string }): Record<string, unknown> {
  if (driverIdForRide(input.ride) !== input.driverId) {
    throw new TripRouteChangeError('This trip is not assigned to the signed-in Driver.', 403);
  }
  if (!isInProgress(input.ride)) {
    throw new TripRouteChangeError('A stop can be completed only while this trip is in progress.', 409);
  }
  const activeTarget = input.ride.route_target && typeof input.ride.route_target === 'object'
    ? input.ride.route_target as RideRecord
    : null;
  const stopId = text(activeTarget?.stop_id, '', 160);
  if (!activeTarget || activeTarget.kind !== 'stop' || !stopId) {
    throw new TripRouteChangeError('There is no active stop to complete.', 409);
  }

  const completedAt = input.completedAt || new Date().toISOString();
  const stops = readPendingStops(input.ride).map((stop) => stop.id === stopId
    ? { ...stop, status: 'completed' as const, completed_at: completedAt }
    : stop,
  );
  if (!stops.some((stop) => stop.id === stopId && stop.status === 'completed')) {
    throw new TripRouteChangeError('The active stop is no longer available.', 409);
  }

  return {
    in_trip_stops: stops,
    route_target: routeTargetFor(input.ride, stops),
    live_route_metrics: null,
    route_change_updated_at: completedAt,
  };
}

async function transactionalRidePatch(
  rideId: string,
  buildPatch: (ride: RideRecord) => Record<string, unknown>,
): Promise<RideRecord> {
  const db = getAdminDb();
  const ref = db.collection(ADMIN_COLLECTIONS.RIDES).doc(rideId);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) throw new TripRouteChangeError('This trip could not be found.', 404);
    const ride = { id: snapshot.id, ...snapshot.data() } as RideRecord;
    const patch = buildPatch(ride);
    const updatedAt = new Date().toISOString();
    transaction.update(ref, { ...patch, updated_date: updatedAt });
    return { ...ride, ...patch, updated_date: updatedAt };
  });
}

export async function requestTripRouteChange(input: {
  rideId: string;
  riderId: string;
  kind: TripRouteChangeKind;
  location: TripRouteLocation;
  quoteId: string;
}) {
  const ride = await transactionalRidePatch(input.rideId, (currentRide) => pendingTripRouteChangePatch({
    ride: currentRide,
    riderId: input.riderId,
    kind: input.kind,
    location: input.location,
    quoteId: input.quoteId,
  }));
  void sendDriverTripRouteChangePush(input.rideId, ride).catch((error) => {
    console.error('[TripRouteChange] Driver notification failed:', error);
  });
  return ride;
}

/** Calculates and stores one short-lived, Rider-owned fare preview for an in-trip route proposal. */
export async function quoteTripRouteChange(input: {
  rideId: string;
  riderId: string;
  kind: TripRouteChangeKind;
  location: TripRouteLocation;
}) {
  const ride = await getAdminDb().collection(ADMIN_COLLECTIONS.RIDES).doc(input.rideId).get();
  if (!ride.exists) throw new TripRouteChangeError('This trip could not be found.', 404);
  const currentRide = { id: ride.id, ...ride.data() } as RideRecord;
  const driverId = driverIdForRide(currentRide);
  if (!driverId) throw new TripRouteChangeError('Waiting for the assigned Driver before calculating the new fare.', 409);
  const driverProfile = await driverProfileForUserId(driverId);
  const quote = await buildTripRouteChangeQuote({
    ride: currentRide,
    riderId: input.riderId,
    kind: input.kind,
    location: input.location,
    driverProfile,
  });
  await transactionalRidePatch(input.rideId, (latestRide) => {
    if (riderIdForRide(latestRide) !== input.riderId) throw new TripRouteChangeError('This trip does not belong to the signed-in Rider.', 403);
    if (!isInProgress(latestRide)) throw new TripRouteChangeError('Route changes can be requested only after the trip has started.', 409);
    if (requestStatus(latestRide) === 'pending') throw new TripRouteChangeError('Your Driver is already reviewing a route change.', 409);
    return { route_change_quote: quote, route_change_updated_at: quote.created_at };
  });
  return quote;
}

export async function reviewTripRouteChange(input: {
  rideId: string;
  driverId: string;
  decision: TripRouteChangeDecision;
}) {
  return transactionalRidePatch(input.rideId, (currentRide) => reviewTripRouteChangePatch({
    ride: currentRide,
    driverId: input.driverId,
    decision: input.decision,
  }));
}

export async function completeActiveTripStop(input: { rideId: string; driverId: string }) {
  return transactionalRidePatch(input.rideId, (currentRide) => completeActiveTripStopPatch({
    ride: currentRide,
    driverId: input.driverId,
  }));
}

async function authenticatedRiderId(request: Request, response: Response): Promise<string | null> {
  const authorization = String(request.headers.authorization || '');
  const idToken = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!idToken) {
    response.status(401).json({ success: false, message: 'Please sign in before changing your trip route.' });
    return null;
  }
  try {
    return (await getAdminAuth().verifyIdToken(idToken)).uid;
  } catch {
    response.status(401).json({ success: false, message: 'Your session has expired. Please sign in again.' });
    return null;
  }
}

/** Registers a Rider-only route-change request. The Driver decision remains server-authoritative. */
export function registerTripRouteChangeRoutes(app: Express) {
  app.post('/api/rides/:rideId/route-change/quote', async (request, response) => {
    const riderId = await authenticatedRiderId(request, response);
    if (!riderId) return;

    const rideId = text(request.params.rideId, '', 160);
    const kind = request.body?.kind === 'destination' || request.body?.kind === 'add_stop'
      ? request.body.kind as TripRouteChangeKind
      : null;
    if (!rideId || !kind) {
      response.status(400).json({ success: false, message: 'Choose whether to change your destination or add a stop.' });
      return;
    }

    try {
      const quote = await quoteTripRouteChange({
        rideId,
        riderId,
        kind,
        location: normalizeTripRouteLocation(request.body?.location),
      });
      response.set('Cache-Control', 'no-store');
      response.status(200).json({ success: true, quote });
    } catch (error) {
      const known = error instanceof TripRouteChangeError;
      if (!known) console.error('[TripRouteChange] Fare quote failed:', error);
      response.status(known ? error.statusCode : 503).json({
        success: false,
        message: known ? error.message : 'The updated fare is temporarily unavailable. Please try again.',
      });
    }
  });

  app.post('/api/rides/:rideId/route-change', async (request, response) => {
    const riderId = await authenticatedRiderId(request, response);
    if (!riderId) return;

    const rideId = text(request.params.rideId, '', 160);
    const kind = request.body?.kind === 'destination' || request.body?.kind === 'add_stop'
      ? request.body.kind as TripRouteChangeKind
      : null;
    const quoteId = text(request.body?.quoteId, '', 160);
    if (!rideId || !kind || !quoteId) {
      response.status(400).json({ success: false, message: 'Review the server-calculated fare before sending a route change.' });
      return;
    }

    try {
      const ride = await requestTripRouteChange({
        rideId,
        riderId,
        kind,
        location: normalizeTripRouteLocation(request.body?.location),
        quoteId,
      });
      response.set('Cache-Control', 'no-store');
      response.status(200).json({ success: true, routeChange: ride.route_change_request });
    } catch (error) {
      const known = error instanceof TripRouteChangeError;
      if (!known) console.error('[TripRouteChange] Rider request failed:', error);
      response.status(known ? error.statusCode : 503).json({
        success: false,
        message: known ? error.message : 'Your route change could not be sent. Please try again.',
      });
    }
  });
}
