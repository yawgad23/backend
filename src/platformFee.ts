import { adminFirestore } from './firebaseAdmin';

const SETTINGS_COLLECTION = 'platform_settings';
const LEGACY_CAR_FEE_DOCUMENT = 'daily_driver_fee';

export type DriverServiceType = 'car' | 'okada' | 'delivery';

const FEE_DOCUMENTS: Record<DriverServiceType, string> = {
  car: 'daily_driver_fee_car',
  okada: 'daily_driver_fee_okada',
  delivery: 'daily_driver_fee_delivery',
};

const DEFAULT_FEES: Record<DriverServiceType, number> = {
  car: 50,
  okada: 30,
  delivery: 30,
};

export type PlatformFeeSetting = {
  amount: number;
  serviceType: DriverServiceType;
  updatedAt: string | null;
  updatedBy: string | null;
  source: 'firestore' | 'default';
};

export function normalizeDriverServiceType(value: unknown): DriverServiceType {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['okada', 'motorbike', 'motorcycle', 'bike'].includes(normalized)) return 'okada';
  if (['delivery', 'courier', 'delivery_rider'].includes(normalized)) return 'delivery';
  return 'car';
}

function validAmount(value: unknown): number | null {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0.01 || amount > 1000) return null;
  return Math.round(amount * 100) / 100;
}

/**
 * Loads a service-specific fee at charge time. The value is intentionally not
 * cached: every Railway replica reads the same administrator-controlled value.
 */
export async function getDailyPlatformFee(serviceTypeInput?: unknown): Promise<PlatformFeeSetting> {
  const serviceType = normalizeDriverServiceType(serviceTypeInput);
  let setting = await adminFirestore.get(SETTINGS_COLLECTION, FEE_DOCUMENTS[serviceType]);

  // Preserve the original global setting as a migration fallback for car
  // drivers until the first service-specific car amount is saved.
  if (!setting && serviceType === 'car') {
    setting = await adminFirestore.get(SETTINGS_COLLECTION, LEGACY_CAR_FEE_DOCUMENT);
  }

  const amount = validAmount(setting?.amount);
  if (amount === null) {
    return {
      amount: DEFAULT_FEES[serviceType],
      serviceType,
      updatedAt: null,
      updatedBy: null,
      source: 'default',
    };
  }

  return {
    amount,
    serviceType,
    updatedAt: typeof setting?.updated_at === 'string' ? setting.updated_at : null,
    updatedBy: typeof setting?.updated_by === 'string' ? setting.updated_by : null,
    source: 'firestore',
  };
}

/** Persists one global daily fee per approved driver service type. */
export async function setDailyPlatformFee(
  serviceTypeInput: unknown,
  amountInput: number,
  updatedBy: string,
): Promise<PlatformFeeSetting> {
  const serviceType = normalizeDriverServiceType(serviceTypeInput);
  const amount = validAmount(amountInput);
  if (amount === null) {
    throw new Error('Platform fee must be between GH₵0.01 and GH₵1,000.00.');
  }

  const updatedAt = new Date().toISOString();
  await adminFirestore.set(SETTINGS_COLLECTION, FEE_DOCUMENTS[serviceType], {
    amount,
    service_type: serviceType,
    updated_at: updatedAt,
    updated_by: updatedBy,
    fee_type: 'fixed_daily_platform_fee',
    currency: 'GHS',
  });

  return { amount, serviceType, updatedAt, updatedBy, source: 'firestore' };
}
