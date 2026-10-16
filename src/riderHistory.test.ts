import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { riderHistoryForOwner, riderHistoryLimit } from './riderHistory';

describe('Rider history server view', () => {
  it('clamps all history read limits before Firestore access', () => {
    expect(riderHistoryLimit(undefined)).toBe(50);
    expect(riderHistoryLimit('4')).toBe(4);
    expect(riderHistoryLimit(0)).toBe(1);
    expect(riderHistoryLimit(999)).toBe(50);
    expect(riderHistoryLimit('bad')).toBe(50);
  });

  it('returns only authenticated Rider records and supports legacy riderId ownership', () => {
    const rows = riderHistoryForOwner([
      { id: 'newer', rider_id: 'rider-1', created_at: '2026-10-16T14:00:00.000Z', destination_address: 'Airport', driver_phone: 'private' },
      { id: 'legacy', riderId: 'rider-1', created_at: '2026-10-15T14:00:00.000Z', destination_address: 'Mall' },
      { id: 'other', rider_id: 'rider-2', created_at: '2026-10-17T14:00:00.000Z', destination_address: 'Private place' },
    ], 'rider-1');

    expect(rows.map((ride) => ride.id)).toEqual(['newer', 'legacy']);
    expect(rows[0]).not.toHaveProperty('driver_phone');
    expect(rows[0]).not.toHaveProperty('rider_id');
  });

  it('deduplicates mirrored historical records and projects only safe display data', () => {
    const rows = riderHistoryForOwner([
      {
        id: 'same-ride',
        rider_id: 'rider-1',
        created_at: { seconds: 1_790_992_000 },
        pickup: { name: 'Accra Mall', address: 'Tetteh Quarshie', lat: 5.6, lng: -0.1 },
        destination: { name: 'Airport', address: 'Kotoka Airport', lat: 5.61, lng: -0.17 },
        final_fare: '17.50',
        driver: { name: 'Kofi', vehicle: 'Toyota', plate: 'GR 1-26', phone: '0240000000' },
        driver_momo_number: '0241111111',
      },
      { id: 'same-ride', riderId: 'rider-1', created_at: { seconds: 1_790_992_000 }, final_fare: '17.50' },
    ], 'rider-1');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'same-ride',
      pickup: { name: 'Accra Mall', address: 'Tetteh Quarshie' },
      destination: { name: 'Airport', address: 'Kotoka Airport' },
      final_fare: 17.5,
      driver_name: 'Kofi',
    });
    expect(rows[0]).not.toHaveProperty('driver_momo_number');
    expect(JSON.stringify(rows[0])).not.toContain('0240000000');
    expect(JSON.stringify(rows[0])).not.toContain('0241111111');
  });

  it('registers the protected Rider-specific history route before the generic ride routes', () => {
    const appSource = readFileSync(resolve(process.cwd(), 'src/app.ts'), 'utf8');
    const routeSource = readFileSync(resolve(process.cwd(), 'src/riderHistory.ts'), 'utf8');

    expect(appSource).toContain("import { registerRiderHistoryRoutes } from './riderHistory'");
    expect(appSource).toContain('registerRiderHistoryRoutes(app);');
    expect(routeSource).toContain("app.get('/api/rider/rides/history'");
    expect(routeSource).toContain('verifyIdToken(idToken)');
    expect(routeSource).toContain("response.set('Cache-Control', 'no-store')");
  });
});
