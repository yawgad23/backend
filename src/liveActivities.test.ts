import { describe, expect, it } from 'vitest';
import { liveActivityPresentation } from './liveActivities';

describe('Rider Live Activity terminal states', () => {
  it('ends a completed trip immediately without waiting for route calculation', async () => {
    const start = Date.now();
    const presentation = await liveActivityPresentation({
      id: 'ride-complete-1',
      status: 'completed',
      destination: { name: 'Airport', lat: 5.605, lng: -0.174 },
      driver_location: { latitude: 5.603, longitude: -0.18 },
    });

    expect(presentation).toEqual({
      event: 'end',
      title: 'Trip complete',
      subtitle: 'Thank you for riding with HY3N',
      arrivalAt: null,
      progress: 1,
    });
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('ends a cancelled ride with a terminal cancellation state', async () => {
    await expect(liveActivityPresentation({ id: 'ride-cancel-1', status: 'cancelled' })).resolves.toMatchObject({
      event: 'end',
      title: 'Ride cancelled',
      arrivalAt: null,
      progress: 1,
    });
  });
});
