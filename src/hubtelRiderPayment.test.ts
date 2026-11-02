import { describe, expect, it } from 'vitest';
import { chargeRiderWalletTopUp } from './hubtel';

describe('Rider Hubtel payment guard', () => {
  const base = {
    customerMsisdn: '0244123456',
    amount: 5,
    clientReference: 'rider-test-reference',
    channel: 'mtn-gh' as const,
    callbackUrl: 'https://example.com/api/hubtel/wallet-callback',
  };

  it('rejects a Driver identity before contacting Hubtel', async () => {
    await expect(chargeRiderWalletTopUp({ ...base, customerName: 'HY3N DRIVER' }))
      .rejects.toThrow(/identity is invalid/i);
  });

  it('rejects an invalid amount before contacting Hubtel', async () => {
    await expect(chargeRiderWalletTopUp({ ...base, amount: 5001, customerName: 'Nana' }))
      .rejects.toThrow(/between GH₵5\.00 and GH₵5,000\.00/i);
  });
});
