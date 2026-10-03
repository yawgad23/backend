export type RiderPaymentProfile = {
  full_name?: unknown;
  name?: unknown;
  display_name?: unknown;
};

/**
 * Wallet funding is denominated in Ghana pesewas. Normalize it once before a
 * transaction record or provider request is created so the stored and charged
 * amount cannot diverge through floating-point representation.
 */
export function normalizeRiderWalletTopUpAmount(rawAmount: number): number {
  if (!Number.isFinite(rawAmount)) throw new Error('Enter a valid top-up amount.');
  const amount = Math.round((rawAmount + Number.EPSILON) * 100) / 100;
  if (amount < 5 || amount > 5000) {
    throw new Error('Wallet top-ups must be between GH₵5.00 and GH₵5,000.00.');
  }
  if (Math.abs(rawAmount - amount) > 0.0000001) {
    throw new Error('Enter a wallet top-up amount with no more than two decimal places.');
  }
  return amount;
}

/**
 * Hubtel's greeting must identify the registered Rider, never a client input
 * or a Driver fee label. Use the Rider's first registered name so a prompt is
 * naturally phrased as, for example, "Hi Nana".
 */
export function registeredRiderPaymentName(profile: RiderPaymentProfile | null | undefined): string {
  const source = [profile?.full_name, profile?.name, profile?.display_name]
    .map((value) => String(value || '').replace(/\s+/g, ' ').trim())
    .find(Boolean);
  const firstName = source?.split(' ')[0]?.slice(0, 80) || '';
  if (!firstName) {
    throw new Error('Please add your name to your Rider profile before topping up your wallet.');
  }
  return firstName;
}

export function riderWalletTopUpDescription(amount: number): string {
  return `HY3N Rider Wallet top-up GH₵${amount.toFixed(2)}`;
}
