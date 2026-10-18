import { describe, expect, it } from 'vitest';
import {
  HY3N_LIVE_ACTIVITY_CONTENT_VERSION,
  HY3N_LIVE_ACTIVITY_IMAGE_NAME,
  isTerminalLiveActivityStatus,
  isTerminalLiveActivityTransition,
  liveActivityContentNeedsRefresh,
  liveActivityPushPriority,
  liveActivityPresentation,
  liveActivityTripProgress,
  shouldDeliverLiveActivityUpdate,
} from './liveActivities';

describe('Rider Live Activity trip progress', () => {
  it('only treats persisted completed or cancelled statuses as terminal', () => {
    expect(isTerminalLiveActivityStatus('completed')).toBe(true);
    expect(isTerminalLiveActivityStatus('cancelled')).toBe(true);
    expect(isTerminalLiveActivityStatus('in_progress')).toBe(false);
    expect(isTerminalLiveActivityTransition('in_progress', 'completed')).toBe(true);
    expect(isTerminalLiveActivityTransition('driver_arriving', 'cancelled')).toBe(true);
    expect(isTerminalLiveActivityTransition('completed', 'completed')).toBe(false);
    expect(isTerminalLiveActivityTransition('in_progress', 'in_progress')).toBe(false);
  });

  it('uses the owned HY3N vehicle asset for native Island updates', () => {
    expect(HY3N_LIVE_ACTIVITY_IMAGE_NAME).toBe('hy3n_trip_car');
  });

  it('marks only outdated Lock Screen content for a one-time refresh', () => {
    expect(liveActivityContentNeedsRefresh(undefined)).toBe(true);
    expect(liveActivityContentNeedsRefresh('pickup-v1')).toBe(true);
    expect(liveActivityContentNeedsRefresh(HY3N_LIVE_ACTIVITY_CONTENT_VERSION)).toBe(false);
  });

  it('advances only as the server road distance to destination shrinks', () => {
    expect(liveActivityTripProgress({ status: 'in_progress', quotedDistanceKm: 10, remainingDistanceKm: 10 })).toBe(0);
    expect(liveActivityTripProgress({ status: 'in_progress', quotedDistanceKm: 10, remainingDistanceKm: 6 })).toBeCloseTo(0.4, 5);
    expect(liveActivityTripProgress({ status: 'in_progress', quotedDistanceKm: 10, remainingDistanceKm: 2, previousProgress: 0.4 })).toBeCloseTo(0.8, 5);
  });

  it('cannot look complete before the server confirms terminal trip state', () => {
    expect(liveActivityTripProgress({ status: 'in_progress', quotedDistanceKm: 10, remainingDistanceKm: 0, previousProgress: 0.8 })).toBe(0.98);
    expect(liveActivityTripProgress({ status: 'in_progress', quotedDistanceKm: 10, remainingDistanceKm: 8, previousProgress: 0.8 })).toBe(0.8);
    expect(liveActivityTripProgress({ status: 'driver_arrived', quotedDistanceKm: 10, remainingDistanceKm: 0.5, previousProgress: 0.8 })).toBe(0);
  });

  it('does not let the display-only progress mutate terminal Live Activity handling', async () => {
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

  it('delivers real movement promptly while keeping unchanged ETA refreshes budget-safe', () => {
    const now = 1_000_000;
    const lastPushAt = new Date(now - 20_000).toISOString();
    expect(shouldDeliverLiveActivityUpdate({
      now, lastPushAt, previousProgress: 0.2, nextProgress: 0.205,
    })).toBe(true);
    expect(liveActivityPushPriority({ previousProgress: 0.2, nextProgress: 0.205 })).toBe('10');
    expect(shouldDeliverLiveActivityUpdate({
      now, lastPushAt, previousProgress: 0.2, nextProgress: 0.2,
    })).toBe(false);
    expect(shouldDeliverLiveActivityUpdate({
      now, lastPushAt: new Date(now - 45_000).toISOString(), previousProgress: 0.2, nextProgress: 0.2,
    })).toBe(true);
    expect(liveActivityPushPriority({ previousProgress: 0.2, nextProgress: 0.2 })).toBe('5');
  });

  it('always sends a forced start, route-state, or terminal update', () => {
    expect(shouldDeliverLiveActivityUpdate({
      now: 1_000_000,
      lastPushAt: new Date(999_999).toISOString(),
      force: true,
      previousProgress: 0.4,
      nextProgress: 0.4,
    })).toBe(true);
    expect(liveActivityPushPriority({ force: true, previousProgress: 0.4, nextProgress: 0.4 })).toBe('10');
  });

  it('uses a clear Rider-facing pickup message before the trip starts', async () => {
    await expect(liveActivityPresentation({
      id: 'ride-pickup-1',
      status: 'driver_arriving',
      driver_name: 'Kofi',
      driver_vehicle: 'White Toyota Vitz',
      pickup: { name: 'Adenta', lat: 5.704, lng: -0.177 },
      destination: { name: 'Accra Mall', lat: 5.605, lng: -0.174 },
    })).resolves.toMatchObject({
      title: 'Pickup in 5 min',
      subtitle: 'Kofi is heading to your pickup',
      progress: 0,
    });
  });
});
