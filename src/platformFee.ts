import { adminFirestore } from './firebaseAdmin';

const SETTINGS_COLLECTION = 'platform_settings';
const DAILY_DRIVER_FEE_DOCUMENT = 'daily_driver_fee';
export const DEFAULT_DAILY_PLATFORM_FEE = 50;

export type PlatformFeeSetting = {
  amount: number;
  updatedAt: string | null;
  updatedBy: string | null;
  source: 'firestore' | 'default';
};

function validAmount(value: unknown): number | null {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0.01 || amount > 1000) return null;
  return Math.round(amount * 100) / 100;
}

/**
 * Loads the platform fee at charge time. This must not be cached in process
 * memory: multiple Railway replicas must always use the same admin setting.
 */
export async function getDailyPlatformFee(): Promise<PlatformFeeSetting> {
  const setting = await adminFirestore.get(SETTINGS_COLLECTION, DAILY_DRIVER_FEE_DOCUMENT);
  const amount = validAmount(setting?.amount);

  if (amount === null) {
    return {
      amount: DEFAULT_DAILY_PLATFORM_FEE,
      updatedAt: null,
      updatedBy: null,
      source: 'default',
    };
  }

  return {
    amount,
    updatedAt: typeof setting?.updated_at === 'string' ? setting.updated_at : null,
    updatedBy: typeof setting?.updated_by === 'string' ? setting.updated_by : null,
    source: 'firestore',
  };
}

/**
 * Persists a single global fee so all driver service types receive the same
 * fixed daily charge. Validation occurs again on the server before any write.
 */
export async function setDailyPlatformFee(
  amountInput: number,
  updatedBy: string,
): Promise<PlatformFeeSetting> {
  const amount = validAmount(amountInput);
  if (amount === null) {
    throw new Error('Platform fee must be between GH₵0.01 and GH₵1,000.00.');
  }

  const updatedAt = new Date().toISOString();
  await adminFirestore.set(SETTINGS_COLLECTION, DAILY_DRIVER_FEE_DOCUMENT, {
    amount,
    updated_at: updatedAt,
    updated_by: updatedBy,
    fee_type: 'fixed_daily_platform_fee',
    currency: 'GHS',
  });

  return { amount, updatedAt, updatedBy, source: 'firestore' };
}
