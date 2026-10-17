export type LegacyTripStop = {
  id: string;
  status: 'pending';
  name: string;
  address: string;
  lat: number;
  lng: number;
  requested_at: string;
};

type RouteLocation = { name: string; address: string; lat: number; lng: number };

function finiteCoordinate(value: unknown, limit: number): number | null {
  const coordinate = Number(value);
  return Number.isFinite(coordinate) && Math.abs(coordinate) <= limit ? coordinate : null;
}

function text(value: unknown, fallback = '', max = 300) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return (normalized || fallback).slice(0, max);
}

function routeLocation(value: unknown): RouteLocation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const lat = finiteCoordinate(source.lat ?? source.latitude, 90);
  const lng = finiteCoordinate(source.lng ?? source.longitude, 180);
  const name = text(source.name ?? source.address, '', 160);
  const address = text(source.address ?? source.name, name, 300);
  return lat === null || lng === null || !name || !address ? null : { name, address, lat, lng };
}

function hasExistingInTripModel(ride: Record<string, unknown>) {
  return (Array.isArray(ride.in_trip_stops) && ride.in_trip_stops.length > 0)
    || Boolean(ride.route_target && typeof ride.route_target === 'object');
}

/**
 * Converts only legacy booking-time `stops` into the server-owned active-trip
 * stop model. It deliberately leaves current `in_trip_stops` / `route_target`
 * records untouched, making the patch safe to call repeatedly and concurrently.
 */
export function legacyBookedStopsPatch(ride: Record<string, unknown>, requestedAt: string): Record<string, unknown> | null {
  if (hasExistingInTripModel(ride) || !Array.isArray(ride.stops)) return null;

  const stops = ride.stops
    .map(routeLocation)
    .filter((stop): stop is RouteLocation => Boolean(stop))
    .map((stop, index): LegacyTripStop => ({
      ...stop,
      id: `booked-stop-${index + 1}`,
      status: 'pending',
      requested_at: requestedAt,
    }));
  if (!stops.length) return null;

  const first = stops[0];
  return {
    in_trip_stops: stops,
    route_target: {
      kind: 'stop',
      stop_id: first.id,
      location: { name: first.name, address: first.address, lat: first.lat, lng: first.lng },
    },
    live_route_metrics: null,
    route_target_migrated_from: 'booked_stops',
  };
}
