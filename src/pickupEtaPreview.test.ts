import { describe, expect, it } from 'vitest';
import { pickupEtaPreviewForCandidates } from './pickupEtaPreview';

describe('server-owned pre-booking pickup ETA', () => {
  it('does not manufacture a one-minute pickup when no eligible Driver exists', () => {
    expect(pickupEtaPreviewForCandidates([], null)).toEqual({
      eligibleDriverCount: 0,
      pickupEtaMinutes: null,
      nearbyVehicles: [],
    });
  });

  it('uses only the road duration returned for the nearest already-eligible Driver', () => {
    expect(pickupEtaPreviewForCandidates([{
      driverId: 'driver-safe',
      latitude: 5.6037,
      longitude: -0.187,
      heading: 90,
      serviceType: 'car',
      vehicleColourHex: '#FFFFFF',
    }], 6.2)).toEqual({
      eligibleDriverCount: 1,
      pickupEtaMinutes: 7,
      nearbyVehicles: [{
        id: 'nearby-1', lat: 5.6037, lng: -0.187, heading: 90, serviceType: 'car', vehicleColourHex: '#FFFFFF',
      }],
    });
  });

  it('does not expose Driver identifiers in pre-selection map vehicle points', () => {
    const preview = pickupEtaPreviewForCandidates([{
      driverId: 'private-driver-id', latitude: 5.6037, longitude: -0.187, serviceType: 'car', vehicleColourHex: '#FFFFFF',
    }], 4);
    expect(JSON.stringify(preview)).not.toContain('private-driver-id');
  });

  it('never falls back to a coordinate-speed estimate when a road duration is unavailable', () => {
    expect(pickupEtaPreviewForCandidates([{
      driverId: 'driver-safe', latitude: 5.6037, longitude: -0.187, serviceType: 'car',
    }], null)).toEqual({
      eligibleDriverCount: 1,
      pickupEtaMinutes: null,
      nearbyVehicles: [{ id: 'nearby-1', lat: 5.6037, lng: -0.187, serviceType: 'car' }],
    });
  });
});
