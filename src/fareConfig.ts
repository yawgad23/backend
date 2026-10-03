import { adminFirestore } from './firebaseAdmin';

export const FARE_CATEGORIES = [
  'standard',
  'comfort',
  'kantanka',
  'executive',
  'okada',
  'express_delivery',
] as const;

export type FareCategory = typeof FARE_CATEGORIES[number];

export type FareRate = {
  baseFare: number;
  pricePerKm: number;
  pricePerMinute: number;
  minFare: number;
  bookingFee: number;
  waitingFeePerMinute: number;
  /** Standard-only inclusive cap on a short route, before paid waiting. */
  shortTripCap?: number;
  /** Standard-only server route distance threshold for the short-trip cap. */
  shortTripMaxDistanceKm?: number;
  /** Standard-only server route duration threshold for the short-trip cap. */
  shortTripMaxDurationMinutes?: number;
  isActive: boolean;
};

export type FareRateConfig = FareRate & {
  category: FareCategory;
  label: string;
  updatedAt?: string | null;
};

const COLLECTION = 'fare_rate_config';
const DEFAULT_CATEGORY: FareCategory = 'standard';

const DEFAULTS: Record<FareCategory, FareRateConfig> = {
  standard: { category: 'standard', label: 'Standard', baseFare: 10, pricePerKm: 3.65, pricePerMinute: 0.43, minFare: 16.5, bookingFee: 0, waitingFeePerMinute: 0.55, shortTripCap: 19, shortTripMaxDistanceKm: 2, shortTripMaxDurationMinutes: 10, isActive: true },
  comfort: { category: 'comfort', label: 'Comfort', baseFare: 16.2, pricePerKm: 4.95, pricePerMinute: 0.65, minFare: 27.5, bookingFee: 0, waitingFeePerMinute: 0.88, isActive: true },
  kantanka: { category: 'kantanka', label: 'Kantanka', baseFare: 16.2, pricePerKm: 4.95, pricePerMinute: 0.65, minFare: 27.5, bookingFee: 0, waitingFeePerMinute: 0.88, isActive: true },
  executive: { category: 'executive', label: 'Executive', baseFare: 27.5, pricePerKm: 6.6, pricePerMinute: 1.1, minFare: 44, bookingFee: 0, waitingFeePerMinute: 1.65, isActive: true },
  okada: { category: 'okada', label: 'Okada', baseFare: 5.5, pricePerKm: 1.65, pricePerMinute: 0.33, minFare: 8.8, bookingFee: 0, waitingFeePerMinute: 0.33, isActive: true },
  express_delivery: { category: 'express_delivery', label: 'Express Delivery', baseFare: 16.5, pricePerKm: 2.2, pricePerMinute: 0.55, minFare: 22, bookingFee: 0, waitingFeePerMinute: 0.55, isActive: true },
};

function finiteInRange(value: unknown, fallback: number, min: number, max: number): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < min || numberValue > max) return fallback;
  return Math.round(numberValue * 100) / 100;
}

function optionalFiniteInRange(value: unknown, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < min || numberValue > max) return undefined;
  return Math.round(numberValue * 100) / 100;
}

function hasShortTripInput(raw: Record<string, unknown>) {
  return [
    raw.shortTripCap,
    raw.short_trip_cap,
    raw.shortTripMaxDistanceKm,
    raw.short_trip_max_distance_km,
    raw.shortTripMaxDurationMinutes,
    raw.short_trip_max_duration_minutes,
  ].some((value) => value !== undefined && value !== null && value !== '');
}

function hasStoredShortTripFields(raw: Record<string, unknown>) {
  return [
    'shortTripCap',
    'short_trip_cap',
    'shortTripMaxDistanceKm',
    'short_trip_max_distance_km',
    'shortTripMaxDurationMinutes',
    'short_trip_max_duration_minutes',
  ].some((field) => Object.prototype.hasOwnProperty.call(raw, field));
}

export function normalizeFareCategory(value: unknown): FareCategory {
  const category = String(value || '').trim().toLowerCase();
  return (FARE_CATEGORIES as readonly string[]).includes(category) ? category as FareCategory : DEFAULT_CATEGORY;
}

export function getDefaultFareRate(category: unknown): FareRateConfig {
  const resolved = normalizeFareCategory(category);
  return { ...DEFAULTS[resolved] };
}

/** Safely reads a persisted/snapshotted rate while retaining a category's known-good bounds. */
export function normalizeFareRate(candidate: unknown, category: unknown): FareRateConfig {
  const fallback = getDefaultFareRate(category);
  const raw = candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : {};
  const activeValue = raw.isActive ?? raw.is_active;
  const isStandard = fallback.category === 'standard';
  const useStandardCapDefaults = isStandard && !hasStoredShortTripFields(raw);
  return {
    category: fallback.category,
    label: fallback.label,
    baseFare: finiteInRange(raw.baseFare ?? raw.base_fare, fallback.baseFare, 0, 500),
    pricePerKm: finiteInRange(raw.pricePerKm ?? raw.per_km_rate, fallback.pricePerKm, 0, 100),
    pricePerMinute: finiteInRange(raw.pricePerMinute ?? raw.per_minute_rate, fallback.pricePerMinute, 0, 50),
    minFare: finiteInRange(raw.minFare ?? raw.minimum_fare, fallback.minFare, 0, 1000),
    bookingFee: finiteInRange(raw.bookingFee ?? raw.booking_fee, fallback.bookingFee, 0, 100),
    waitingFeePerMinute: finiteInRange(raw.waitingFeePerMinute ?? raw.waiting_fee_per_minute, fallback.waitingFeePerMinute, 0, 100),
    ...(isStandard ? {
      shortTripCap: useStandardCapDefaults
        ? fallback.shortTripCap
        : optionalFiniteInRange(raw.shortTripCap ?? raw.short_trip_cap, 0, 1000),
      shortTripMaxDistanceKm: useStandardCapDefaults
        ? fallback.shortTripMaxDistanceKm
        : optionalFiniteInRange(raw.shortTripMaxDistanceKm ?? raw.short_trip_max_distance_km, 0.1, 100),
      shortTripMaxDurationMinutes: useStandardCapDefaults
        ? fallback.shortTripMaxDurationMinutes
        : optionalFiniteInRange(raw.shortTripMaxDurationMinutes ?? raw.short_trip_max_duration_minutes, 1, 180),
    } : {}),
    isActive: typeof activeValue === 'boolean' ? activeValue : fallback.isActive,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : (typeof raw.updated_at === 'string' ? raw.updated_at : null),
  };
}

export function validateFareRateUpdate(input: unknown, category: unknown): FareRateConfig {
  const fallback = getDefaultFareRate(category);
  const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  // HY3N currently settles trip fares directly in cash with the Driver. A
  // booking fee cannot be retained by HY3N in that model, so it is always zero
  // on new settings and new quote snapshots. Historical snapshots remain intact.
  const rate = { ...normalizeFareRate(raw, category), bookingFee: 0 };
  if (rate.minFare < rate.bookingFee) throw new Error('Minimum fare cannot be lower than the booking fee.');
  if (rate.baseFare + rate.bookingFee > 1000) throw new Error('Base fare configuration is outside the supported range.');
  if (rate.category !== 'standard' && hasShortTripInput(raw)) {
    throw new Error('The short-trip cap is available for Standard rides only.');
  }
  if (rate.category === 'standard' && hasShortTripInput(raw)) {
    const capFields = [rate.shortTripCap, rate.shortTripMaxDistanceKm, rate.shortTripMaxDurationMinutes];
    if (!capFields.every((value) => value !== undefined)) {
      throw new Error('Provide the Standard short-trip cap, maximum distance, and maximum duration together.');
    }
    if ((rate.shortTripCap as number) < rate.minFare + rate.bookingFee) {
      throw new Error('The Standard short-trip cap cannot be lower than the minimum fare plus booking fee.');
    }
  }
  return { ...rate, label: fallback.label };
}

export async function getFareRateConfig(category: unknown): Promise<FareRateConfig> {
  const resolved = normalizeFareCategory(category);
  const stored = await adminFirestore.get(COLLECTION, resolved);
  // Existing configuration may still contain the retired fee. Never use it to
  // issue a new quote while direct cash settlement is in effect.
  return { ...normalizeFareRate(stored, resolved), bookingFee: 0 };
}

export async function listFareRateConfigs(): Promise<FareRateConfig[]> {
  return Promise.all(FARE_CATEGORIES.map((category) => getFareRateConfig(category)));
}

export async function setFareRateConfig(category: unknown, input: unknown, updatedBy: string): Promise<FareRateConfig> {
  const rate = validateFareRateUpdate(input, category);
  const saved = await adminFirestore.set(COLLECTION, rate.category, {
    category: rate.category,
    label: rate.label,
    baseFare: rate.baseFare,
    pricePerKm: rate.pricePerKm,
    pricePerMinute: rate.pricePerMinute,
    minFare: rate.minFare,
    bookingFee: rate.bookingFee,
    waitingFeePerMinute: rate.waitingFeePerMinute,
    shortTripCap: rate.shortTripCap ?? null,
    shortTripMaxDistanceKm: rate.shortTripMaxDistanceKm ?? null,
    shortTripMaxDurationMinutes: rate.shortTripMaxDurationMinutes ?? null,
    isActive: rate.isActive,
    updated_by: updatedBy,
  });
  return normalizeFareRate(saved, rate.category);
}

export async function getActiveSurgeMultiplier(): Promise<number> {
  const setting = await adminFirestore.get('platform_settings', 'surge_pricing');
  const configured = Number(setting?.manual_multiplier);
  return setting?.manual_enabled === true && Number.isFinite(configured)
    ? Math.min(2, Math.max(1, Math.round(configured * 100) / 100))
    : 1;
}
