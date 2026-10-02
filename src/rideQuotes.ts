import { getMeteredFareBreakdown, type MeteredFareBreakdown } from './fareAuthority';
import { adminFirestore, getAdminDb } from './firebaseAdmin';
import {
  normalizeFareCategory,
  normalizeFareRate,
  type FareCategory,
  type FareRateConfig,
} from './fareConfig';

export const RIDE_QUOTES_COLLECTION = 'ride_quotes';
// A fare remains locked long enough for a Rider to compare categories, add a
// passenger or delivery contact, and confirm payment. The quote is still
// server-bound to the exact route, account, category, rate snapshot and use.
export const RIDE_QUOTE_TTL_MS = 15 * 60 * 1000;

export type QuoteLocation = {
  lat: number;
  lng: number;
};

export type QuoteRoute = {
  pickup: QuoteLocation;
  destination: QuoteLocation;
  stops?: QuoteLocation[];
  distanceKm: number;
  durationMinutes: number;
};

export type RideQuoteSnapshot = {
  id?: string;
  rider_id: string;
  category: FareCategory;
  route_fingerprint: string;
  distance_km: number;
  duration_minutes: number;
  fare_rate_snapshot: FareRateConfig;
  surge_multiplier: number;
  quote_breakdown: MeteredFareBreakdown;
  quoted_fare: number;
  base_fare: number;
  status: 'open' | 'consumed' | 'expired';
  expires_at: string;
  created_at: string;
  consumed_at?: string;
  ride_id?: string;
};

export type RideQuoteValidation =
  | { ok: true; quote: RideQuoteSnapshot }
  | { ok: false; code: 'not_found' | 'forbidden' | 'consumed' | 'expired' | 'mismatch'; message: string };

function fixedNumber(value: unknown, decimals: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  const factor = 10 ** decimals;
  return Math.round(parsed * factor) / factor;
}

function fixedCoordinate(value: unknown): number {
  return fixedNumber(value, 5);
}

export function normalizeQuoteMetrics(route: Pick<QuoteRoute, 'distanceKm' | 'durationMinutes'>) {
  return {
    distanceKm: fixedNumber(route.distanceKm, 3),
    durationMinutes: fixedNumber(route.durationMinutes, 1),
  };
}

/** A deterministic coordinate binding without trusting a device's route metrics. */
export function routeFingerprint(route: QuoteRoute): string {
  const location = (point: QuoteLocation) => `${fixedCoordinate(point.lat)},${fixedCoordinate(point.lng)}`;
  const stops = (route.stops || []).map(location).join('|');
  return [location(route.pickup), location(route.destination), stops].join('~');
}

export function quoteExpiry(now = Date.now()): string {
  return new Date(now + RIDE_QUOTE_TTL_MS).toISOString();
}

export function makeRideQuoteSnapshot(input: {
  riderId: string;
  category: unknown;
  route: QuoteRoute;
  fareRate: unknown;
  surgeMultiplier: unknown;
  now?: number;
}): RideQuoteSnapshot {
  const category = normalizeFareCategory(input.category);
  const metrics = normalizeQuoteMetrics(input.route);
  const rate = normalizeFareRate(input.fareRate, category);
  const breakdown = getMeteredFareBreakdown({
    category,
    distanceKm: metrics.distanceKm,
    durationMinutes: metrics.durationMinutes,
    surgeMultiplier: input.surgeMultiplier,
    fareRate: rate,
  });
  const now = input.now ?? Date.now();
  return {
    rider_id: input.riderId,
    category,
    route_fingerprint: routeFingerprint({ ...input.route, ...metrics }),
    distance_km: metrics.distanceKm,
    duration_minutes: metrics.durationMinutes,
    fare_rate_snapshot: rate,
    surge_multiplier: breakdown.surgeMultiplier,
    quote_breakdown: breakdown,
    quoted_fare: breakdown.total,
    base_fare: breakdown.baseFare,
    status: 'open',
    expires_at: quoteExpiry(now),
    created_at: new Date(now).toISOString(),
  };
}

export function validateRideQuote(input: {
  quote: Record<string, unknown> | null | undefined;
  quoteId?: string;
  riderId: string;
  category: unknown;
  route: QuoteRoute;
  now?: number;
}): RideQuoteValidation {
  if (!input.quote) {
    return { ok: false, code: 'not_found', message: 'This fare quote was not found. Refresh pricing and try again.' };
  }
  const quote = input.quote as RideQuoteSnapshot;
  if (String(quote.rider_id || '') !== input.riderId) {
    return { ok: false, code: 'forbidden', message: 'This fare quote belongs to another account.' };
  }
  if (quote.status === 'consumed' || quote.ride_id) {
    return { ok: false, code: 'consumed', message: 'This fare quote has already been used.' };
  }
  const expiresAt = new Date(String(quote.expires_at || '')).getTime();
  if (quote.status !== 'open' || !Number.isFinite(expiresAt) || expiresAt <= (input.now ?? Date.now())) {
    return { ok: false, code: 'expired', message: 'This fare quote has expired. Refresh pricing and try again.' };
  }
  if (normalizeFareCategory(input.category) !== normalizeFareCategory(quote.category)) {
    return { ok: false, code: 'mismatch', message: 'The selected category changed. Refresh pricing and try again.' };
  }
  const coordinateFingerprint = routeFingerprint(input.route);
  // Builds released before the server-road-route correction appended client
  // metrics to this value. Retain those locked quotes only when their exact
  // coordinate prefix matches; all new quotes use the metrics-free form.
  const storedFingerprint = String(quote.route_fingerprint || '');
  const routeMatches = storedFingerprint === coordinateFingerprint
    || storedFingerprint.startsWith(`${coordinateFingerprint}~`);
  if (!routeMatches) {
    return { ok: false, code: 'mismatch', message: 'Your route changed. Refresh pricing and try again.' };
  }
  return {
    ok: true,
    quote: {
      ...quote,
      id: input.quoteId,
      category: normalizeFareCategory(quote.category),
      fare_rate_snapshot: normalizeFareRate(quote.fare_rate_snapshot, quote.category),
      quote_breakdown: quote.quote_breakdown as MeteredFareBreakdown,
      quoted_fare: Number(quote.quoted_fare),
      base_fare: Number(quote.base_fare),
      distance_km: Number(quote.distance_km),
      duration_minutes: Number(quote.duration_minutes),
      surge_multiplier: Number(quote.surge_multiplier),
    },
  };
}

export async function createRideQuote(snapshot: RideQuoteSnapshot): Promise<RideQuoteSnapshot> {
  const created = await adminFirestore.create(RIDE_QUOTES_COLLECTION, snapshot);
  return { ...snapshot, id: created.id };
}

export async function getOpenRideQuoteForPayment(riderId: string, quoteId: string): Promise<RideQuoteValidation> {
  const quote = await adminFirestore.get(RIDE_QUOTES_COLLECTION, quoteId);
  if (!quote) {
    return { ok: false, code: 'not_found', message: 'This fare quote was not found. Refresh pricing and try again.' };
  }
  if (String(quote.rider_id || '') !== riderId) {
    return { ok: false, code: 'forbidden', message: 'This fare quote belongs to another account.' };
  }
  if (quote.status === 'consumed' || quote.ride_id) {
    return { ok: false, code: 'consumed', message: 'This fare quote has already been used.' };
  }
  const expiresAt = new Date(String(quote.expires_at || '')).getTime();
  if (quote.status !== 'open' || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return { ok: false, code: 'expired', message: 'This fare quote has expired. Refresh pricing and try again.' };
  }
  return {
    ok: true,
    quote: {
      ...(quote as RideQuoteSnapshot),
      id: quoteId,
      category: normalizeFareCategory(quote.category),
      fare_rate_snapshot: normalizeFareRate(quote.fare_rate_snapshot, quote.category),
      quote_breakdown: quote.quote_breakdown as MeteredFareBreakdown,
      quoted_fare: Number(quote.quoted_fare),
      base_fare: Number(quote.base_fare),
      distance_km: Number(quote.distance_km),
      duration_minutes: Number(quote.duration_minutes),
      surge_multiplier: Number(quote.surge_multiplier),
    },
  };
}

/**
 * Atomically consumes a server-created quote and creates one ride. The caller
 * supplies route details only to prove that the displayed quote is still for
 * that exact route; its fare, surge and category rate never become authority.
 */
export async function consumeRideQuoteAndCreateRide(input: {
  quoteId: string;
  riderId: string;
  category: unknown;
  route: QuoteRoute;
  rideData: Record<string, unknown>;
  cardCheckoutTransactionId?: string;
}): Promise<{ ride: Record<string, unknown>; quote: RideQuoteSnapshot }> {
  const db = getAdminDb();
  const quoteRef = db.collection(RIDE_QUOTES_COLLECTION).doc(input.quoteId);
  const rideRef = db.collection('rides').doc();
  const cardTransactionRef = input.cardCheckoutTransactionId
    ? db.collection('wallet_transactions').doc(input.cardCheckoutTransactionId)
    : null;

  return db.runTransaction(async (transaction) => {
    const [quoteSnapshot, cardSnapshot] = await Promise.all([
      transaction.get(quoteRef),
      cardTransactionRef ? transaction.get(cardTransactionRef) : Promise.resolve(null),
    ]);
    const quoteData = quoteSnapshot.exists ? (quoteSnapshot.data() || {}) as Record<string, unknown> : null;
    const validation = validateRideQuote({
      quote: quoteData,
      quoteId: input.quoteId,
      riderId: input.riderId,
      category: input.category,
      route: input.route,
    });
    if (!validation.ok) {
      const error = new Error(validation.message) as Error & { code?: string };
      error.code = validation.code;
      throw error;
    }

    if (cardTransactionRef) {
      const cardTransaction = cardSnapshot?.exists ? (cardSnapshot.data() || {}) as Record<string, unknown> : null;
      const cardAmount = Number(cardTransaction?.amount);
      if (
        !cardTransaction
        || String(cardTransaction.user_id || '') !== input.riderId
        || cardTransaction.status !== 'completed'
        || cardTransaction.checkout_purpose !== 'ride_quote'
        || String(cardTransaction.ride_quote_id || '') !== input.quoteId
        || !Number.isFinite(cardAmount)
        || cardAmount !== validation.quote.quoted_fare
        || cardTransaction.ride_id
      ) {
        const error = new Error('The confirmed card payment does not match this fare quote.') as Error & { code?: string };
        error.code = 'payment_mismatch';
        throw error;
      }
    }

    const now = new Date().toISOString();
    const ride = {
      ...input.rideData,
      id: rideRef.id,
      category: validation.quote.category,
      fare: validation.quote.quoted_fare,
      fare_estimate: validation.quote.quoted_fare,
      quoted_fare: validation.quote.quoted_fare,
      base_fare: validation.quote.base_fare,
      quote_id: input.quoteId,
      quote_accepted_at: now,
      surge_multiplier: validation.quote.surge_multiplier,
      fare_rate_snapshot: validation.quote.fare_rate_snapshot,
      quote_breakdown: validation.quote.quote_breakdown,
      distance: validation.quote.distance_km,
      distance_km: validation.quote.distance_km,
      estimated_distance_km: validation.quote.distance_km,
      duration: validation.quote.duration_minutes,
      estimated_duration_minutes: validation.quote.duration_minutes,
      created_date: now,
      updated_date: now,
    };
    transaction.set(rideRef, ride);
    transaction.update(quoteRef, { status: 'consumed', consumed_at: now, ride_id: rideRef.id, updated_date: now });
    if (cardTransactionRef) transaction.update(cardTransactionRef, { ride_id: rideRef.id, quote_consumed_at: now, updated_date: now });
    return { ride, quote: validation.quote };
  });
}
