import { describe, expect, it } from 'vitest';
import { driverCanServeRideCategory, receiptDeliveryState, receiptEmail } from './driverRouters';

describe('receiptEmail', () => {
  it('accepts a real Rider email address', () => {
    expect(receiptEmail(' Rider@Example.com ')).toBe('rider@example.com');
  });

  it('rejects malformed recipient values', () => {
    expect(receiptEmail('not-an-email')).toBe('');
    expect(receiptEmail(null)).toBe('');
  });

  it('rejects internal phone-auth placeholder addresses', () => {
    expect(receiptEmail('phone-233123456789@hy3n.local')).toBe('');
  });
});

describe('receiptDeliveryState', () => {
  const currentTime = Date.parse('2026-09-25T15:00:00.000Z');

  it('keeps a sent receipt idempotent', () => {
    expect(receiptDeliveryState({ receipt_email_sent: true }, currentTime)).toBe('sent');
    expect(receiptDeliveryState({ receipt_email_delivery_status: 'sent' }, currentTime)).toBe('sent');
  });

  it('blocks a second send while the first SMTP delivery is active', () => {
    expect(receiptDeliveryState({
      receipt_email_delivery_status: 'sending',
      receipt_email_delivery_started_at: '2026-09-25T14:50:00.000Z',
    }, currentTime)).toBe('sending');
  });

  it('allows a retry after a failed or stale delivery lock', () => {
    expect(receiptDeliveryState({ receipt_email_delivery_status: 'failed' }, currentTime)).toBe('ready');
    expect(receiptDeliveryState({
      receipt_email_delivery_status: 'sending',
      receipt_email_delivery_started_at: '2026-09-25T14:40:00.000Z',
    }, currentTime)).toBe('ready');
  });
});

describe('driverCanServeRideCategory', () => {
  it('allows Kantanka Drivers to receive Comfort and Kantanka requests', () => {
    expect(driverCanServeRideCategory({ service_type: 'car', ride_categories: ['kantanka'] }, 'comfort')).toBe(true);
    expect(driverCanServeRideCategory({ service_type: 'car', ride_categories: ['kantanka'] }, 'kantanka')).toBe(true);
  });

  it('does not allow Comfort-only Drivers to receive Kantanka requests', () => {
    expect(driverCanServeRideCategory({ service_type: 'car', ride_categories: ['comfort'] }, 'kantanka')).toBe(false);
    expect(driverCanServeRideCategory({ service_type: 'car', ride_categories: ['comfort'] }, 'comfort')).toBe(true);
  });

  it('keeps Standard matching exact for categorized cars', () => {
    expect(driverCanServeRideCategory({ service_type: 'car', ride_categories: ['standard'] }, 'standard')).toBe(true);
    expect(driverCanServeRideCategory({ service_type: 'car', ride_categories: ['kantanka'] }, 'standard')).toBe(false);
  });
});
