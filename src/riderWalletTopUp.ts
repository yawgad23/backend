export type RiderPaymentProfile = {
  full_name?: unknown;
  name?: unknown;
  display_name?: unknown;
};

export type RiderWalletTopUpPayment = {
  /** Server-normalized Ghana cedi amount passed to both Firestore and Hubtel. */
  amount: number;
  /** Registered Rider first name for Hubtel's greeting, e.g. "Hi Nana". */
  customerName: string;
  /** Explicitly Rider-only provider label; never a Driver platform fee. */
  description: string;
  /** Stored with the ledger row for payment-type reconciliation. */
  paymentPurpose: 'rider_wallet_top_up';
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

/**
 * Produces the one authoritative value set for a Rider wallet payment. The
 * client may supply its selected amount, but the server owns normalization,
 * registered identity, provider description, and the ledger purpose. Keeping
 * these values together prevents a Rider wallet request from being recorded
 * or presented as a Driver daily-platform-fee request.
 */
export function buildRiderWalletTopUpPayment(
  profile: RiderPaymentProfile | null | undefined,
  rawAmount: number,
): RiderWalletTopUpPayment {
  const amount = normalizeRiderWalletTopUpAmount(rawAmount);
  return {
    amount,
    customerName: registeredRiderPaymentName(profile),
    description: riderWalletTopUpDescription(amount),
    paymentPurpose: 'rider_wallet_top_up',
  };
}
