import { describe, expect, it } from 'vitest';
import { hostedCheckoutUrlFromPayload, parseCardCheckoutState } from '../src/cardCheckout';

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
});
