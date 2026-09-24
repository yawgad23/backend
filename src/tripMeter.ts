export type MeterLocation = {
  latitude: number;
  longitude: number;
  recordedAt?: string;
};

export type TripMeter = {
  version: 1;
  started_at: string;
  last_accepted_location: MeterLocation | null;
  last_accepted_at: string | null;
  last_observed_at: string | null;
  distance_km: number;
  accepted_samples: number;
  ignored_noise_samples: number;
  ignored_jump_samples: number;
};

const MIN_DISTANCE_INCREMENT_KM = 0.025; // 25 m: filters normal GPS drift.
const MAX_REASONABLE_SPEED_KMH = 150;
const MAX_INCREMENT_KM = 5;

function finiteCoordinate(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function timestamp(value: unknown, fallback: string): string {
  const parsed = new Date(String(value || '')).getTime();
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

export function haversineKilometres(from: MeterLocation, to: MeterLocation): number {
  const radians = (value: number) => value * Math.PI / 180;
  const earthRadiusKm = 6371;
  const latitudeDelta = radians(to.latitude - from.latitude);
  const longitudeDelta = radians(to.longitude - from.longitude);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(from.latitude)) * Math.cos(radians(to.latitude)) * Math.sin(longitudeDelta / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function initializeTripMeter(startedAt: string, initialLocation?: Partial<MeterLocation> | null): TripMeter {
  const latitude = finiteCoordinate(initialLocation?.latitude);
  const longitude = finiteCoordinate(initialLocation?.longitude);
  const location = latitude === null || longitude === null
    ? null
    : { latitude, longitude, recordedAt: startedAt };

  return {
    version: 1,
    started_at: startedAt,
    last_accepted_location: location,
    last_accepted_at: location ? startedAt : null,
    last_observed_at: startedAt,
    distance_km: 0,
    accepted_samples: 0,
    ignored_noise_samples: 0,
    ignored_jump_samples: 0,
  };
}

export function advanceTripMeter(existing: unknown, observation: Partial<MeterLocation>, observedAt: string): {
  meter: TripMeter;
  accepted: boolean;
  incrementKm: number;
  ignoredReason?: 'invalid' | 'noise' | 'jump';
} {
  const previous = (existing && typeof existing === 'object' ? existing : {}) as Partial<TripMeter>;
  const normalizedObservedAt = timestamp(observedAt, new Date().toISOString());
  const latitude = finiteCoordinate(observation.latitude);
  const longitude = finiteCoordinate(observation.longitude);
  const baseline = initializeTripMeter(
    timestamp(previous.started_at, normalizedObservedAt),
    previous.last_accepted_location,
  );
  const meter: TripMeter = {
    ...baseline,
    ...previous,
    version: 1,
    distance_km: Number.isFinite(Number(previous.distance_km)) && Number(previous.distance_km) >= 0
      ? Number(previous.distance_km)
      : 0,
    accepted_samples: Number.isFinite(Number(previous.accepted_samples)) ? Number(previous.accepted_samples) : 0,
    ignored_noise_samples: Number.isFinite(Number(previous.ignored_noise_samples)) ? Number(previous.ignored_noise_samples) : 0,
    ignored_jump_samples: Number.isFinite(Number(previous.ignored_jump_samples)) ? Number(previous.ignored_jump_samples) : 0,
    last_observed_at: normalizedObservedAt,
  };

  if (latitude === null || longitude === null || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    return { meter, accepted: false, incrementKm: 0, ignoredReason: 'invalid' };
  }

  const nextLocation: MeterLocation = { latitude, longitude, recordedAt: normalizedObservedAt };
  const last = meter.last_accepted_location;
  if (!last) {
    meter.last_accepted_location = nextLocation;
    meter.last_accepted_at = normalizedObservedAt;
    return { meter, accepted: false, incrementKm: 0 };
  }

  const incrementKm = haversineKilometres(last, nextLocation);
  if (incrementKm < MIN_DISTANCE_INCREMENT_KM) {
    meter.ignored_noise_samples += 1;
    return { meter, accepted: false, incrementKm: 0, ignoredReason: 'noise' };
  }

  const lastAcceptedMs = new Date(String(meter.last_accepted_at || meter.started_at)).getTime();
  const observedMs = new Date(normalizedObservedAt).getTime();
  const elapsedHours = Math.max(1 / 120, (observedMs - lastAcceptedMs) / 3_600_000);
  const maximumPlausibleDistance = Math.min(
    MAX_INCREMENT_KM,
    Math.max(0.25, MAX_REASONABLE_SPEED_KMH * elapsedHours + 0.15),
  );
  if (!Number.isFinite(incrementKm) || incrementKm > maximumPlausibleDistance) {
    meter.ignored_jump_samples += 1;
    return { meter, accepted: false, incrementKm: 0, ignoredReason: 'jump' };
  }

  meter.distance_km = Number((meter.distance_km + incrementKm).toFixed(3));
  meter.accepted_samples += 1;
  meter.last_accepted_location = nextLocation;
  meter.last_accepted_at = normalizedObservedAt;
  return { meter, accepted: true, incrementKm: Number(incrementKm.toFixed(3)) };
}
