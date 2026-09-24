import { describe, expect, it } from 'vitest';
import { buildHubtelCardCheckoutPayload, hostedCheckoutUrlFromPayload, parseCardCheckoutState } from '../src/cardCheckout';

describe('Hubtel card checkout response handling', () => {
  it('accepts only secure hosted checkout URLs', () => {
    expect(hostedCheckoutUrlFromPayload({ checkout_url: 'https://unified-pay.hubtel.com/pay/session-123' }))
      .toBe('https://unified-pay.hubtel.com/pay/session-123');
    expect(hostedCheckoutUrlFromPayload({ response_text: 'https://pay.hubtel.com/checkout/abc' }))
      .toBe('https://pay.hubtel.com/checkout/abc');
    expect(hostedCheckoutUrlFromPayload({ checkout_url: 'javascript:alert(1)' })).toBeUndefined();
  });

  it('does not mistake an API response code for a paid card transaction', () => {
    expect(parseCardCheckoutState({ ResponseCode: '0000' })).toBe('processing');
    expect(parseCardCheckoutState({ Data: { Status: 'Paid' } })).toBe('paid');
    expect(parseCardCheckoutState({ status: 'Declined' })).toBe('failed');
  });

  it('serializes the merchant account as Hubtel requires', () => {
    const payload = buildHubtelCardCheckoutPayload({
      amount: 5,
      customerName: 'HY3N Rider',
      reference: 'hy3n-card-test',
      description: 'HY3N wallet top-up',
      callbackUrl: 'https://example.com/callback',
      returnUrl: 'https://example.com/return',
    });

    expect(payload.totalAmount).toBe(5);
    expect(payload.merchantAccountNumber).toEqual(expect.any(String));
    expect(payload.clientReference).toBe('hy3n-card-test');
  });
});
