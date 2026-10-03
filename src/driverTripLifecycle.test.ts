import { describe, expect, it } from 'vitest';
import { canPersistDriverTripMeter, isCompletedRideForDriver } from './driverTripLifecycle';

describe('Driver trip terminal lifecycle guards', () => {
  it('permits meter writes only for the assigned Driver during an active trip', () => {
    expect(canPersistDriverTripMeter({ driver_id: 'driver-1', status: 'in_progress' }, 'driver-1')).toBe(true);
    expect(canPersistDriverTripMeter({ driver_id: 'driver-1', status: 'completed' }, 'driver-1')).toBe(false);
    expect(canPersistDriverTripMeter({ driver_id: 'driver-1', status: 'cancelled' }, 'driver-1')).toBe(false);
    expect(canPersistDriverTripMeter({ driver_id: 'driver-2', status: 'in_progress' }, 'driver-1')).toBe(false);
  });

  it('recognizes only a same-Driver completed record as a safe completion replay', () => {
    expect(isCompletedRideForDriver({ driver_id: 'driver-1', status: 'completed' }, 'driver-1')).toBe(true);
    expect(isCompletedRideForDriver({ driver_id: 'driver-1', status: 'in_progress' }, 'driver-1')).toBe(false);
    expect(isCompletedRideForDriver({ driver_id: 'driver-2', status: 'completed' }, 'driver-1')).toBe(false);
  });
});
