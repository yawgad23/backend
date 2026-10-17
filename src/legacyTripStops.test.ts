import { describe, expect, it } from 'vitest';
import { legacyBookedStopsPatch } from './legacyTripStops';
import { completeActiveTripStopPatch } from './tripRouteChange';

const destination = { name: 'Final destination', address: 'Final destination', lat: 5.61, lng: -0.18 };
const firstStop = { name: 'First stop', address: 'First stop', lat: 5.62, lng: -0.181 };
const secondStop = { name: 'Second stop', address: 'Second stop', lat: 5.63, lng: -0.182 };

function legacyRide(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ride-1',
    status: 'in_progress',
    driver_id: 'driver-1',
    destination,
    stops: [firstStop, secondStop],
    ...overrides,
  };
}

describe('legacy booked stop promotion', () => {
  it('promotes ordered booking stops into the active server-owned stop model', () => {
    expect(legacyBookedStopsPatch(legacyRide(), '2026-10-17T19:00:00.000Z')).toMatchObject({
      in_trip_stops: [
        { id: 'booked-stop-1', status: 'pending', ...firstStop },
        { id: 'booked-stop-2', status: 'pending', ...secondStop },
      ],
      route_target: { kind: 'stop', stop_id: 'booked-stop-1', location: firstStop },
      live_route_metrics: null,
    });
  });

  it('is idempotent and never overwrites a modern active stop or route target', () => {
    expect(legacyBookedStopsPatch(legacyRide({
      in_trip_stops: [{ id: 'modern-stop', status: 'pending', ...firstStop }],
      route_target: { kind: 'stop', stop_id: 'modern-stop', location: firstStop },
    }), '2026-10-17T19:00:00.000Z')).toBeNull();
  });

  it('uses the existing server completion flow for next stop then final destination', () => {
    const promoted = legacyBookedStopsPatch(legacyRide(), '2026-10-17T19:00:00.000Z');
    expect(promoted).not.toBeNull();
    const afterFirst = { ...legacyRide(), ...promoted };
    const firstCompletion = completeActiveTripStopPatch({
      ride: afterFirst,
      driverId: 'driver-1',
      completedAt: '2026-10-17T19:05:00.000Z',
    });
    expect(firstCompletion.route_target).toMatchObject({
      kind: 'stop', stop_id: 'booked-stop-2', location: secondStop,
    });

    const afterSecond = { ...afterFirst, ...firstCompletion };
    const secondCompletion = completeActiveTripStopPatch({
      ride: afterSecond,
      driverId: 'driver-1',
      completedAt: '2026-10-17T19:10:00.000Z',
    });
    expect(secondCompletion.route_target).toMatchObject({ kind: 'destination', location: destination });
  });

  it('does not manufacture a stop from malformed legacy booking data', () => {
    expect(legacyBookedStopsPatch(legacyRide({ stops: [{ name: 'Missing coordinates' }] }), '2026-10-17T19:00:00.000Z')).toBeNull();
  });
});
