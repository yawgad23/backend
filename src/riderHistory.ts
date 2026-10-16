import type { Express, Request, Response } from 'express';
import { adminFirestore, ADMIN_COLLECTIONS, getAdminAuth } from './firebaseAdmin';
import { riderOwnsRideStatus } from './riderRideStatus';

const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 50;
const FALLBACK_SCAN_LIMIT = 200;

type RecordLike = Record<string, unknown>;

type TimestampLike = {
  toDate?: () => Date;
  seconds?: unknown;
};

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 320) : fallback;
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function historyDate(value: unknown): string | undefined {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
  }
  if (value && typeof value === 'object') {
    const timestamp = value as TimestampLike;
    if (typeof timestamp.toDate === 'function') {
      const date = timestamp.toDate();
      if (date instanceof Date && Number.isFinite(date.getTime())) return date.toISOString();
    }
    const seconds = finiteNumber(timestamp.seconds);
    if (seconds !== undefined) return new Date(seconds * 1000).toISOString();
  }
  return undefined;
}

function riderLocation(value: unknown): string | { name?: string; address?: string } | undefined {
  if (typeof value === 'string') return text(value) || undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as RecordLike;
  const name = text(source.name ?? source.label);
  const address = text(source.address ?? source.formatted_address);
  return name || address ? { ...(name ? { name } : {}), ...(address ? { address } : {}) } : undefined;
}

function ownRideProjection(ride: RecordLike): RecordLike {
  const createdAt = historyDate(ride.created_at ?? ride.created_date ?? ride.completed_at ?? ride.updated_date);
  const completedAt = historyDate(ride.completed_at);
  const rideId = text(ride.id ?? ride.ride_id, 'unknown-ride');

  // This is deliberately a display projection. In particular, Driver contact,
  // payout, internal assignment, navigation, and payment-provider fields never
  // leave the server through history.
  return {
    id: rideId,
    status: text(ride.status, 'completed'),
    category: text(ride.category ?? ride.category_name ?? ride.service_type, 'Ride'),
    pickup_address: text(ride.pickup_address),
    destination_address: text(ride.destination_address),
    pickup: riderLocation(ride.pickup),
    destination: riderLocation(ride.destination),
    actual_distance_km: finiteNumber(ride.actual_distance_km),
    distance_km: finiteNumber(ride.distance_km ?? ride.distance),
    actual_duration_min: finiteNumber(ride.actual_duration_min),
    duration_minutes: finiteNumber(ride.duration_minutes ?? ride.duration),
    quoted_fare: finiteNumber(ride.quoted_fare ?? ride.fare_estimate),
    final_fare: finiteNumber(ride.final_fare ?? ride.finalFare ?? ride.fare),
    fare: finiteNumber(ride.fare),
    payment: text(ride.payment ?? ride.payment_method, 'Not recorded'),
    payment_method: text(ride.payment_method),
    driver_name: text(ride.driver_name ?? (ride.driver as RecordLike | undefined)?.name),
    driver_vehicle: text(ride.driver_vehicle ?? (ride.driver as RecordLike | undefined)?.vehicle),
    driver_plate: text(ride.driver_plate ?? (ride.driver as RecordLike | undefined)?.plate),
    driver_rating: finiteNumber(ride.driver_rating ?? (ride.driver as RecordLike | undefined)?.rating),
    rider_rating: finiteNumber(ride.rider_rating),
    tip: finiteNumber(ride.tip ?? ride.tip_amount),
    tip_amount: finiteNumber(ride.tip_amount),
    waiting_fee: finiteNumber(ride.waiting_fee),
    scheduled_for: text(ride.scheduled_for),
    promo_code: text(ride.promo_code),
    discount: finiteNumber(ride.discount),
    ...(createdAt ? { created_at: createdAt, created_date: createdAt } : {}),
    ...(completedAt ? { completed_at: completedAt } : {}),
  };
}

function historyTimestamp(ride: RecordLike): number {
  const timestamp = historyDate(ride.created_at ?? ride.created_date ?? ride.completed_at);
  const parsed = timestamp ? new Date(timestamp).getTime() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Clamps the history size before it reaches Firestore. */
export function riderHistoryLimit(value: unknown): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return DEFAULT_HISTORY_LIMIT;
  return Math.min(MAX_HISTORY_LIMIT, Math.max(1, parsed));
}

/** Filters, deduplicates, sorts, and privacy-minimizes records for one Rider. */
export function riderHistoryForOwner(records: RecordLike[], riderId: string, limit = DEFAULT_HISTORY_LIMIT): RecordLike[] {
  const byId = new Map<string, RecordLike>();
  for (const ride of records) {
    if (!riderOwnsRideStatus(ride, riderId)) continue;
    const projected = ownRideProjection(ride);
    if (projected.id === 'unknown-ride') continue;
    const id = String(projected.id);
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, projected);
      continue;
    }
    // The `rider_id` and legacy `riderId` queries can return a mirrored record
    // for the same trip. Keep the first complete projection, filling only
    // fields that it did not contain instead of replacing a valid route or
    // Driver display name with an empty legacy value.
    const merged = { ...existing };
    for (const [key, value] of Object.entries(projected)) {
      if (value !== undefined && value !== '') merged[key] = value;
    }
    byId.set(id, merged);
  }
  return [...byId.values()]
    .sort((left, right) => historyTimestamp(right) - historyTimestamp(left))
    .slice(0, riderHistoryLimit(limit));
}

async function queryHistoryField(riderId: string, field: 'rider_id' | 'riderId', limit: number) {
  try {
    return await adminFirestore.list(ADMIN_COLLECTIONS.RIDES, { [field]: riderId }, 'created_at', 'desc', limit);
  } catch {
    // Some legacy records do not carry the current query's timestamp field or
    // may be waiting for a composite index. This bounded fallback retains only
    // the authenticated Rider's own records after server-side filtering.
    return adminFirestore.list(ADMIN_COLLECTIONS.RIDES, { [field]: riderId }, null, 'desc', FALLBACK_SCAN_LIMIT);
  }
}

export async function readRiderHistory(riderId: string, limit: unknown = DEFAULT_HISTORY_LIMIT): Promise<RecordLike[]> {
  const cappedLimit = riderHistoryLimit(limit);
  const results = await Promise.allSettled([
    queryHistoryField(riderId, 'rider_id', cappedLimit),
    queryHistoryField(riderId, 'riderId', cappedLimit),
  ]);
  const records = results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
  if (!records.length && results.every((result) => result.status === 'rejected')) {
    throw new Error('Ride history could not be read.');
  }
  return riderHistoryForOwner(records, riderId, cappedLimit);
}

async function authenticatedRiderId(request: Request, response: Response): Promise<string | null> {
  const authorization = String(request.headers.authorization || '');
  const idToken = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!idToken) {
    response.status(401).json({ success: false, message: 'Please sign in to view your ride history.' });
    return null;
  }
  try {
    return (await getAdminAuth().verifyIdToken(idToken)).uid;
  } catch {
    response.status(401).json({ success: false, message: 'Your session has expired. Please sign in again.' });
    return null;
  }
}

/** Registers a private, server-owned History read for authenticated Riders. */
export function registerRiderHistoryRoutes(app: Express) {
  app.get('/api/rider/rides/history', async (request, response) => {
    const riderId = await authenticatedRiderId(request, response);
    if (!riderId) return;

    try {
      const rides = await readRiderHistory(riderId, request.query.limit);
      response.set('Cache-Control', 'no-store');
      response.status(200).json({ success: true, rides });
    } catch (error) {
      console.error('[RiderHistory] Protected history read failed:', error);
      response.status(503).json({ success: false, message: 'Your ride history is temporarily unavailable. Please pull to refresh.' });
    }
  });
}
