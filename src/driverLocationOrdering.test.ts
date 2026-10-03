import { describe, expect, it } from 'vitest';
import { shouldPersistDriverLocation } from './driverLocationOrdering';

describe('Driver location ordering', () => {
  const prior = { current_location: { recorded_at: '2026-10-02T16:00:03.000Z' } };

  it('persists a current GPS sample and rejects a delayed sample', () => {
    expect(shouldPersistDriverLocation(prior, '2026-10-02T16:00:06.000Z')).toBe(true);
    expect(shouldPersistDriverLocation(prior, '2026-10-02T16:00:00.000Z')).toBe(false);
  });

  it('accepts a first valid sample and rejects a malformed timestamp', () => {
    expect(shouldPersistDriverLocation(null, '2026-10-02T16:00:00.000Z')).toBe(true);
    expect(shouldPersistDriverLocation(null, 'not-a-date')).toBe(false);
  });

  it('orders coordinates by their source GPS time rather than the newer server heartbeat time', () => {
    const priorHeartbeat = {
      current_location: {
        recorded_at: '2026-10-02T16:10:00.000Z',
        source_recorded_at: '2026-10-02T16:00:06.000Z',
      },
    };
    expect(shouldPersistDriverLocation(priorHeartbeat, '2026-10-02T16:00:05.000Z')).toBe(false);
    expect(shouldPersistDriverLocation(priorHeartbeat, '2026-10-02T16:00:06.000Z')).toBe(true);
  });
});
