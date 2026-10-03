import { describe, expect, it } from 'vitest';
import {
  normalizeRiderWalletTopUpAmount,
  registeredRiderPaymentName,
  riderWalletTopUpDescription,
} from './riderWalletTopUp';

describe('Rider wallet top-up identity and amount', () => {
  it('uses the registered Rider first name rather than a client-provided Driver label', () => {
    expect(registeredRiderPaymentName({ full_name: ' Nana   Owusu ' })).toBe('Nana');
    expect(() => registeredRiderPaymentName({ full_name: '   ' })).toThrow(/Rider profile/i);
  });

  it('keeps the stored and charged amount to two Ghana-pesewa decimals', () => {
    expect(normalizeRiderWalletTopUpAmount(5)).toBe(5);
    expect(normalizeRiderWalletTopUpAmount(5.2)).toBe(5.2);
    expect(() => normalizeRiderWalletTopUpAmount(4.99)).toThrow(/between/i);
    expect(() => normalizeRiderWalletTopUpAmount(5.123)).toThrow(/two decimal/i);
  });

  it('labels each provider charge as a Rider wallet top-up with the exact amount', () => {
    expect(riderWalletTopUpDescription(5)).toBe('HY3N Rider Wallet top-up GH₵5.00');
  });
});
