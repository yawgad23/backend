function timeMs(value: unknown): number | null {
  if (!value) return null;
  const parsed = new Date(String(value)).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

/** Reject a delayed device sample so every Rider sees a monotonic presence path. */
export function shouldPersistDriverLocation(previous: Record<string, any> | null | undefined, incomingRecordedAt: string): boolean {
  const incomingMs = timeMs(incomingRecordedAt);
  if (incomingMs === null) return false;
  const location = previous?.current_location || previous?.location || previous || {};
  // Server receipt time is the availability heartbeat. Coordinate ordering
  // stays tied to the originating GPS sample time when that metadata exists.
  const existingMs = timeMs(location.source_recorded_at ?? location.recorded_at ?? location.updated_at ?? previous?.last_location_update ?? previous?.last_seen_at ?? previous?.last_seen);
  return existingMs === null || incomingMs >= existingMs;
}
