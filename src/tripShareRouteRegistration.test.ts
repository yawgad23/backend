import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const appSource = readFileSync(resolve(process.cwd(), 'src/app.ts'), 'utf8');
const shareSource = readFileSync(resolve(process.cwd(), 'src/tripShare.ts'), 'utf8');

describe('live trip sharing API registration', () => {
  it('registers the authenticated Rider share endpoints in the production Express app', () => {
    expect(appSource).toContain('registerTripShareRoutes(app);');
    expect(appSource).toContain("import { registerTripShareRoutes } from \"./tripShare\"");
  });

  it('keeps sharing private, time-bounded, revocable, and limited to active rides', () => {
    expect(shareSource).toContain("const ACTIVE_STATUSES = new Set(['matched', 'driver_arriving', 'driver_arrived', 'in_progress'])");
    expect(shareSource).toContain('const SHARE_DURATION_MS = 8 * 60 * 60 * 1000');
    expect(shareSource).toContain("app.post('/api/rider/trips/:rideId/share'");
    expect(shareSource).toContain("app.delete('/api/rider/trips/:rideId/share'");
    expect(shareSource).toContain("app.get('/api/public/trips/:token/status'");
    expect(shareSource).toContain("status: 'revoked'");
  });
});
