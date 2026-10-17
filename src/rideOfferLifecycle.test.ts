import { describe, expect, it } from 'vitest';
import {
  DRIVER_OFFER_RESPONSE_MS,
  declinedDriverOfferPatch,
  driverCanReviewOffer,
  isCurrentDriverOffer,
  nextDriverOfferPatch,
  shouldDispatchDriverOffer,
  timedOutDriverOfferPatch,
  timedOutOfferPatchForDriver,
  waitingForDriverOfferPatch,
} from './rideOfferLifecycle';

const startedAt = Date.parse('2026-10-17T17:00:00.000Z');
const searchExpiresAt = new Date(startedAt + 6 * 60_000).toISOString();
const baseRide = {
  id: 'ride-1',
  status: 'searching',
  search_expires_at: searchExpiresAt,
};

describe('server-owned Driver offer lifecycle', () => {
  it('gives exactly one selected Driver a 60-second review lease', () => {
    const patch = nextDriverOfferPatch(baseRide, 'driver-nearest', new Date(startedAt));
    expect(patch).toMatchObject({
      offered_driver_id: 'driver-nearest',
      offered_to_driver_ids: ['driver-nearest'],
      driver_offer_attempt: 1,
      driver_offer_status: 'pending',
      driver_offer_expires_at: new Date(startedAt + DRIVER_OFFER_RESPONSE_MS).toISOString(),
    });
  });

  it('allows only the current selected Driver before the server deadline', () => {
    const ride = { ...baseRide, ...nextDriverOfferPatch(baseRide, 'driver-1', new Date(startedAt)) };
    expect(driverCanReviewOffer(ride, 'driver-1', startedAt + DRIVER_OFFER_RESPONSE_MS - 1)).toBe(true);
    expect(driverCanReviewOffer(ride, 'driver-2', startedAt + 5_000)).toBe(false);
    expect(isCurrentDriverOffer(ride, startedAt + DRIVER_OFFER_RESPONSE_MS - 1)).toBe(true);
    expect(isCurrentDriverOffer(ride, startedAt + DRIVER_OFFER_RESPONSE_MS)).toBe(false);
  });

  it('moves to the next closest candidate when a targeted offer expires', () => {
    const first = { ...baseRide, ...nextDriverOfferPatch(baseRide, 'driver-1', new Date(startedAt)) };
    expect(shouldDispatchDriverOffer(first, startedAt + DRIVER_OFFER_RESPONSE_MS - 1)).toBe(false);
    expect(shouldDispatchDriverOffer(first, startedAt + DRIVER_OFFER_RESPONSE_MS)).toBe(true);

    const next = nextDriverOfferPatch(first, 'driver-2', new Date(startedAt + DRIVER_OFFER_RESPONSE_MS));
    expect(next).toMatchObject({
      offered_driver_id: 'driver-2',
      offered_to_driver_ids: ['driver-1', 'driver-2'],
      driver_offer_attempt: 2,
    });
    expect(driverCanReviewOffer({ ...first, ...next }, 'driver-1', startedAt + DRIVER_OFFER_RESPONSE_MS + 1)).toBe(false);
    expect(driverCanReviewOffer({ ...first, ...next }, 'driver-2', startedAt + DRIVER_OFFER_RESPONSE_MS + 1)).toBe(true);
  });

  it('marks an elapsed lease ready for immediate server handoff when its Driver is still polling', () => {
    const first = { ...baseRide, ...nextDriverOfferPatch(baseRide, 'driver-1', new Date(startedAt)) };
    const timedOut = { ...first, ...timedOutDriverOfferPatch(first, new Date(startedAt + DRIVER_OFFER_RESPONSE_MS)) };
    expect(timedOut).toMatchObject({ offered_driver_id: null, driver_offer_status: 'timed_out' });
    expect(shouldDispatchDriverOffer(timedOut, startedAt + DRIVER_OFFER_RESPONSE_MS)).toBe(true);
    expect(driverCanReviewOffer(timedOut, 'driver-1', startedAt + DRIVER_OFFER_RESPONSE_MS)).toBe(false);
  });

  it('treats a selected Driver decline at the exact server deadline as a timeout, not an error', () => {
    const first = { ...baseRide, ...nextDriverOfferPatch(baseRide, 'driver-1', new Date(startedAt)) };
    const patch = timedOutOfferPatchForDriver(first, 'driver-1', new Date(startedAt + DRIVER_OFFER_RESPONSE_MS));
    expect(patch).toMatchObject({ offered_driver_id: null, driver_offer_status: 'timed_out' });
    const timedOut = { ...first, ...patch };
    expect(shouldDispatchDriverOffer(timedOut, startedAt + DRIVER_OFFER_RESPONSE_MS)).toBe(true);
    expect(timedOutOfferPatchForDriver(first, 'driver-2', new Date(startedAt + DRIVER_OFFER_RESPONSE_MS))).toBeNull();
  });

  it('advances immediately after an explicit decline but does not re-offer the same request', () => {
    const first = { ...baseRide, ...nextDriverOfferPatch(baseRide, 'driver-1', new Date(startedAt)) };
    const declined = { ...first, ...declinedDriverOfferPatch(first, 'driver-1', new Date(startedAt + 5_000)) };
    expect((declined as Record<string, unknown>).declined_by_driver_ids).toEqual(['driver-1']);
    expect(shouldDispatchDriverOffer(declined, startedAt + 5_000)).toBe(true);
    const second = nextDriverOfferPatch(declined, 'driver-2', new Date(startedAt + 5_000));
    expect(second.offered_to_driver_ids).toEqual(['driver-1', 'driver-2']);
  });

  it('waits briefly when no eligible Driver is available instead of looping offers', () => {
    const waiting = { ...baseRide, ...waitingForDriverOfferPatch(baseRide, new Date(startedAt)) };
    expect(shouldDispatchDriverOffer(waiting, startedAt + 59_999)).toBe(false);
    expect(shouldDispatchDriverOffer(waiting, startedAt + 60_000)).toBe(true);
  });

  it('never extends a lease beyond the fixed Rider search deadline', () => {
    const nearEnd = new Date(startedAt + 6 * 60_000 - 10_000);
    const patch = nextDriverOfferPatch(baseRide, 'driver-last', nearEnd);
    expect(patch.driver_offer_expires_at).toBe(searchExpiresAt);
    const ride = { ...baseRide, ...patch };
    expect(driverCanReviewOffer(ride, 'driver-last', startedAt + 6 * 60_000 - 1)).toBe(true);
    expect(driverCanReviewOffer(ride, 'driver-last', startedAt + 6 * 60_000)).toBe(false);
  });

  it('keeps legacy open rides readable only until the first server target is written', () => {
    expect(driverCanReviewOffer(baseRide, 'legacy-driver', startedAt)).toBe(true);
    const targeted = { ...baseRide, ...nextDriverOfferPatch(baseRide, 'driver-1', new Date(startedAt)) };
    expect(driverCanReviewOffer(targeted, 'legacy-driver', startedAt + 1)).toBe(false);
  });
});
