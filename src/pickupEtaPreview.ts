import { adminFirestore } from './firebaseAdmin';
import { driverOfferCandidates, type DriverOfferCandidate, type DriverPresence } from './driverOfferPush';
import { isApprovedDriverProfile, driverProfileForUserId } from './driverApproval';
import { hasCurrentPlatformFee } from './driverRouters';
import { fetchRoadRoute } from './liveRouteMetrics';

const MAX_DISPATCH_CANDIDATES = 24;

export type PickupEtaPreview = {
  eligibleDriverCount: number;
  pickupEtaMinutes: number | null;
  /** Anonymous display-only positions for the booking map, never Driver IDs. */
  nearbyVehicles: Array<{
    id: string;
    lat: number;
    lng: number;
    heading?: number;
    serviceType: 'car' | 'okada' | 'delivery';
    vehicleColourHex?: string;
  }>;
};

/**
 * Formats only availability metadata that a Rider may see. Vehicle points are
 * anonymous display tokens; no Driver ID, profile, or contact data is returned.
 */
export function pickupEtaPreviewForCandidates(
  candidates: readonly DriverOfferCandidate[],
  roadDurationMinutes: unknown,
): PickupEtaPreview {
  const duration = roadDurationMinutes === null || roadDurationMinutes === undefined
    ? Number.NaN
    : Number(roadDurationMinutes);
  return {
    eligibleDriverCount: candidates.length,
    pickupEtaMinutes: candidates.length > 0 && Number.isFinite(duration) && duration >= 0
      ? Math.max(1, Math.ceil(duration))
      : null,
    nearbyVehicles: candidates.slice(0, 8).map((candidate, index) => ({
      id: `nearby-${index + 1}`,
      lat: candidate.latitude,
      lng: candidate.longitude,
      ...(Number.isFinite(Number(candidate.heading)) ? { heading: Number(candidate.heading) } : {}),
      serviceType: candidate.serviceType ?? 'car',
      ...(candidate.vehicleColourHex ? { vehicleColourHex: candidate.vehicleColourHex } : {}),
    })),
  };
}

/**
 * Uses the same fresh/category/radius/preference ordering as dispatch, then
 * rechecks the canonical approved account and rolling fee entitlement. This is
 * a display preview only: it does not reserve, notify, or identify a Driver.
 */
export async function pickupEtaPreviewForRide(
  ride: Record<string, unknown>,
  presences?: DriverPresence[],
  now = Date.now(),
): Promise<PickupEtaPreview> {
  const sourcePresences = presences
    ?? await adminFirestore.list('driver_presence', {}, null, 'desc', 500) as DriverPresence[];
  const ordered = driverOfferCandidates(ride, sourcePresences, now, MAX_DISPATCH_CANDIDATES);
  const eligible: DriverOfferCandidate[] = [];

  for (const candidate of ordered) {
    const profile = await driverProfileForUserId(candidate.driverId);
    if (!isApprovedDriverProfile(profile)) continue;
    if (!await hasCurrentPlatformFee(candidate.driverId, profile)) continue;
    eligible.push(candidate);
  }

  const nearest = eligible[0];
  if (!nearest) return pickupEtaPreviewForCandidates([], null);

  const pickup = ride.pickup && typeof ride.pickup === 'object'
    ? ride.pickup as Record<string, unknown>
    : {};
  const pickupLatitude = Number(pickup.lat ?? pickup.latitude);
  const pickupLongitude = Number(pickup.lng ?? pickup.longitude);
  if (!Number.isFinite(pickupLatitude) || !Number.isFinite(pickupLongitude)) {
    return pickupEtaPreviewForCandidates(eligible, null);
  }

  // Unlike fare quoting, do not substitute a coordinate-speed fallback here.
  // A pickup minute must be a real road-route result or remain unknown.
  const roadRoute = await fetchRoadRoute(
    { latitude: nearest.latitude, longitude: nearest.longitude },
    { latitude: pickupLatitude, longitude: pickupLongitude },
  );
  return pickupEtaPreviewForCandidates(eligible, roadRoute?.durationMinutes ?? null);
}
