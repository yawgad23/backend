import { describe, expect, it } from 'vitest';
import {
  completeActiveTripStopPatch,
  normalizeTripRouteLocation,
  pendingTripRouteChangePatch,
  reviewTripRouteChangePatch,
} from './tripRouteChange';

const destination = { name: 'Airport', address: 'Kotoka Airport', lat: 5.605, lng: -0.167 };
const requestedLocation = { name: 'Accra Mall', address: 'Tetteh Quarshie', lat: 5.625, lng: -0.173 };
const validQuote = {
  id: 'quote-1',
  status: 'quoted',
  kind: 'destination',
  location: requestedLocation,
  estimated_total: 44,
  estimated_remaining_distance_km: 9.1,
  estimated_remaining_duration_minutes: 22,
  estimated_total_distance_km: 12.4,
  estimated_total_duration_minutes: 30,
  created_at: '2026-10-16T15:00:00.000Z',
  expires_at: '2099-10-16T15:05:00.000Z',
};

function activeRide(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ride-1',
    status: 'in_progress',
    rider_id: 'rider-1',
    driver_id: 'driver-1',
    destination,
    route_change_quote: validQuote,
    ...overrides,
  };
}

describe('in-trip route changes', () => {
  it('rejects malformed route locations before a request is persisted', () => {
    expect(() => normalizeTripRouteLocation({ name: 'Place', address: 'Somewhere', lat: 200, lng: 0 }))
      .toThrow('Choose a valid address');
  });

  it('requires Rider confirmation of the matching server quote before notifying a Driver', () => {
    const patch = pendingTripRouteChangePatch({
      ride: activeRide(),
      riderId: 'rider-1',
      kind: 'destination',
      location: requestedLocation,
      quoteId: 'quote-1',
      requestedAt: '2026-10-16T15:01:00.000Z',
      requestId: 'change-1',
    });

    expect(patch).toMatchObject({
      route_change_quote: null,
      route_change_request: {
        id: 'change-1',
        status: 'pending',
        kind: 'destination',
        location: requestedLocation,
        quote: { id: 'quote-1', estimated_total: 44 },
      },
    });
    expect(patch).not.toHaveProperty('fare');
    expect(patch).not.toHaveProperty('wallet');
  });

  it('does not allow a Rider to send a different location than the fare they reviewed', () => {
    expect(() => pendingTripRouteChangePatch({
      ride: activeRide(),
      riderId: 'rider-1',
      kind: 'destination',
      location: { ...requestedLocation, lat: 5.626 },
      quoteId: 'quote-1',
    })).toThrow('does not match the fare');
  });

  it('only changes the destination after the assigned Driver accepts', () => {
    const ride = activeRide({
      route_change_request: {
        id: 'change-1', status: 'pending', kind: 'destination', location: requestedLocation, rider_id: 'rider-1',
      },
    });
    const patch = reviewTripRouteChangePatch({ ride, driverId: 'driver-1', decision: 'accept', reviewedAt: '2026-10-16T15:02:00.000Z' });

    expect(patch).toMatchObject({
      destination: requestedLocation,
      destination_address: requestedLocation.address,
      route_target: { kind: 'destination', location: requestedLocation },
      route_change_request: { status: 'accepted' },
      live_route_metrics: null,
    });
    expect(patch).not.toHaveProperty('fare');
    expect(patch).not.toHaveProperty('final_fare');
  });

  it('keeps a Driver-approved stop as the live navigation target until Driver marks it reached', () => {
    const ride = activeRide({
      route_change_request: {
        id: 'stop-1', status: 'pending', kind: 'add_stop', location: requestedLocation, rider_id: 'rider-1',
      },
    });
    const accepted = reviewTripRouteChangePatch({ ride, driverId: 'driver-1', decision: 'accept', reviewedAt: '2026-10-16T15:02:00.000Z' });
    const afterAccept = { ...ride, ...accepted };
    expect(accepted).toMatchObject({
      route_target: { kind: 'stop', stop_id: 'stop-1', location: requestedLocation },
      in_trip_stops: [{ id: 'stop-1', status: 'pending', name: requestedLocation.name }],
    });

    const completed = completeActiveTripStopPatch({ ride: afterAccept, driverId: 'driver-1', completedAt: '2026-10-16T15:10:00.000Z' });
    expect(completed).toMatchObject({
      route_target: { kind: 'destination', location: destination },
      in_trip_stops: [{ id: 'stop-1', status: 'completed' }],
      live_route_metrics: null,
    });
  });

  it('does not allow a non-assigned Driver to apply a request', () => {
    const ride = activeRide({ route_change_request: { id: 'change-1', status: 'pending', kind: 'destination', location: requestedLocation } });
    expect(() => reviewTripRouteChangePatch({ ride, driverId: 'other-driver', decision: 'accept' }))
      .toThrow('not assigned');
  });
});
