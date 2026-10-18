import { describe, expect, it } from 'vitest';
import {
  DRIVER_HIGH_RATED_RIDER_MINIMUM,
  DRIVER_LONG_TRIP_MINIMUM_KM,
  driverAllowsRideByDistance,
  driverOfferPreferencePriority,
  normalizeDriverOfferPreferences,
  preferencesForDriverRecord,
} from './driverOfferPreferences';

describe('server-owned Driver offer preferences', () => {
  it('normalizes only explicit Boolean settings and keeps a safe default shape', () => {
    expect(normalizeDriverOfferPreferences({ autoAccept: true, notifications: false })).toEqual({
      notifications: false,
      soundAlerts: true,
      autoAccept: true,
      longTripsOnly: false,
      preferHighRated: true,
      destinationFilter: null,
    });
  });

  it('enforces Long Trips Only as strictly over 10 km', () => {
    const preferences = normalizeDriverOfferPreferences({ longTripsOnly: true });
    expect(DRIVER_LONG_TRIP_MINIMUM_KM).toBe(10);
    expect(driverAllowsRideByDistance({ distance_km: 10 }, preferences)).toBe(false);
    expect(driverAllowsRideByDistance({ distance_km: 10.01 }, preferences)).toBe(true);
    expect(driverAllowsRideByDistance({}, preferences)).toBe(false);
  });

  it('never promotes an unrated Rider into the high-rated preference tier', () => {
    const preferences = normalizeDriverOfferPreferences({ preferHighRated: true });
    expect(DRIVER_HIGH_RATED_RIDER_MINIMUM).toBe(4.5);
    expect(driverOfferPreferencePriority({ rider_rating: null, rider_rating_count: 0 }, preferences)).toBe(2);
    expect(driverOfferPreferencePriority({ rider_rating: 4.5, rider_rating_count: 1 }, preferences)).toBe(0);
    expect(driverOfferPreferencePriority({ rider_rating: 4.4, rider_rating_count: 100 }, preferences)).toBe(2);
  });

  it('reads the current profile preference shape before legacy driver_preferences', () => {
    expect(preferencesForDriverRecord({
      preferences: { notifications: false },
      driver_preferences: { notifications: true },
    }).notifications).toBe(false);
  });
});
