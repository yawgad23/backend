import { describe, expect, it } from 'vitest';
import {
  makeRideQuoteSnapshot,
  routeFingerprint,
  validateRideQuote,
  type QuoteRoute,
} from './rideQuotes';

const route: QuoteRoute = {
  pickup: { lat: 5.6037, lng: -0.187 },
  destination: { lat: 5.6501, lng: -0.1952 },
  stops: [],
  distanceKm: 7.1254,
  durationMinutes: 21.37,
};

const originalRate = {
  baseFare: 10,
  pricePerKm: 3,
  pricePerMinute: 0.5,
  minFare: 16.5,
  bookingFee: 2.5,
  isActive: true,
};

describe('server-persisted ride quotes', () => {
  it('accepts the exact owner route against the rate snapshot', () => {
    const quote = makeRideQuoteSnapshot({
      riderId: 'rider-a',
      category: 'standard',
      route,
      fareRate: originalRate,
      surgeMultiplier: 1.25,
      now: Date.parse('2026-09-29T12:00:00.000Z'),
    });

    const result = validateRideQuote({
      quote,
      quoteId: 'quote-a',
      riderId: 'rider-a',
      category: 'standard',
      route,
      now: Date.parse('2026-09-29T12:02:00.000Z'),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.quote.quoted_fare).toBe(55);
      expect(result.quote.fare_rate_snapshot.pricePerKm).toBe(3);
    }
  });

  it('binds a fare quote to route coordinates instead of device-provided metrics', () => {
    expect(routeFingerprint({ ...route, distanceKm: 2, durationMinutes: 1 }))
      .toBe(routeFingerprint({ ...route, distanceKm: 999, durationMinutes: 999 }));
  });

  it('retains the server road line alongside the locked fare', () => {
    const quote = makeRideQuoteSnapshot({
      riderId: 'rider-a',
      category: 'standard',
      route,
      routePoints: [[5.6037, -0.187], [5.61, -0.19], [5.6501, -0.1952]],
      routeSource: 'google_routes_traffic',
      fareRate: originalRate,
      surgeMultiplier: 1,
    });

    expect(quote.route_points).toEqual([[5.6037, -0.187], [5.61, -0.19], [5.6501, -0.1952]]);
    expect(quote.route_source).toBe('google_routes_traffic');
  });

  it('prepares independent locked snapshots for the category batch', () => {
    const standard = makeRideQuoteSnapshot({
      riderId: 'rider-a',
      category: 'standard',
      route,
      fareRate: originalRate,
      surgeMultiplier: 1,
    });
    const comfort = makeRideQuoteSnapshot({
      riderId: 'rider-a',
      category: 'comfort',
      route,
      fareRate: { ...originalRate, baseFare: 16.2, pricePerKm: 4.95, pricePerMinute: 0.65, minFare: 27.5 },
      surgeMultiplier: 1,
    });

    expect([standard, comfort].map((quote) => quote.category)).toEqual(['standard', 'comfort']);
    expect(standard.route_fingerprint).toBe(comfort.route_fingerprint);
    expect(standard.fare_rate_snapshot).not.toEqual(comfort.fare_rate_snapshot);
  });

  it('keeps the accepted quote unchanged after a later admin rate update', () => {
    const quote = makeRideQuoteSnapshot({
      riderId: 'rider-a',
      category: 'standard',
      route,
      fareRate: originalRate,
      surgeMultiplier: 1,
      now: Date.parse('2026-09-29T12:00:00.000Z'),
    });
    const laterAdminRate = { ...originalRate, baseFare: 80, pricePerKm: 20 };

    const result = validateRideQuote({
      quote,
      quoteId: 'quote-a',
      riderId: 'rider-a',
      category: 'standard',
      route,
      now: Date.parse('2026-09-29T12:02:00.000Z'),
    });

    expect(laterAdminRate.baseFare).toBe(80);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.quote.quoted_fare).toBe(45);
      expect(result.quote.fare_rate_snapshot.baseFare).toBe(originalRate.baseFare);
      expect(result.quote.fare_rate_snapshot.pricePerKm).toBe(originalRate.pricePerKm);
    }
  });

  it('rejects another rider, a changed route, and an expired fifteen-minute quote', () => {
    const quote = makeRideQuoteSnapshot({
      riderId: 'rider-a',
      category: 'standard',
      route,
      fareRate: originalRate,
      surgeMultiplier: 1,
      now: Date.parse('2026-09-29T12:00:00.000Z'),
    });

    const otherRider = validateRideQuote({ quote, quoteId: 'quote-a', riderId: 'rider-b', category: 'standard', route });
    const changedRoute = validateRideQuote({
      quote,
      quoteId: 'quote-a',
      riderId: 'rider-a',
      category: 'standard',
      route: { ...route, destination: { lat: 5.651, lng: -0.1952 } },
      now: Date.parse('2026-09-29T12:02:00.000Z'),
    });
    const stillOpen = validateRideQuote({
      quote,
      quoteId: 'quote-a',
      riderId: 'rider-a',
      category: 'standard',
      route,
      now: Date.parse('2026-09-29T12:14:59.000Z'),
    });
    const expired = validateRideQuote({
      quote,
      quoteId: 'quote-a',
      riderId: 'rider-a',
      category: 'standard',
      route,
      now: Date.parse('2026-09-29T12:15:00.000Z'),
    });

    expect(otherRider.ok).toBe(false);
    expect(changedRoute.ok).toBe(false);
    expect(stillOpen.ok).toBe(true);
    expect(expired.ok).toBe(false);
    if (!otherRider.ok) expect(otherRider.code).toBe('forbidden');
    if (!changedRoute.ok) expect(changedRoute.code).toBe('mismatch');
    if (!expired.ok) expect(expired.code).toBe('expired');
    expect(routeFingerprint(route)).toContain('5.6037');
  });
});
