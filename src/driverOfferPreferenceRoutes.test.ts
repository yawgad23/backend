import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const routeSource = readFileSync(resolve(process.cwd(), 'src/driverOfferPreferenceRoutes.ts'), 'utf8');
const appSource = readFileSync(resolve(process.cwd(), 'src/app.ts'), 'utf8');

describe('Driver offer preference API registration', () => {
  it('requires a verified Firebase token and persists only validated preference values', () => {
    expect(routeSource).toContain("app.put('/api/driver/offer-preferences'");
    expect(routeSource).toContain('verifyIdToken(token, true)');
    expect(routeSource).toContain('driverOfferPreferencesInput.safeParse');
    expect(routeSource).toContain('saveDriverOfferPreferences(driverId, parsed.data)');
    expect(appSource).toContain('registerDriverOfferPreferenceRoutes(app)');
  });
});
