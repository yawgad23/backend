function text(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

/** Terminal states never accept late Driver meter writes. */
export function canPersistDriverTripMeter(ride: Record<string, any> | null | undefined, driverId: string): boolean {
  return text(ride?.driver_id) === text(driverId) && text(ride?.status) === 'in_progress';
}

/** A same-Driver completion replay must return the stored server result. */
export function isCompletedRideForDriver(ride: Record<string, any> | null | undefined, driverId: string): boolean {
  return text(ride?.driver_id) === text(driverId) && text(ride?.status) === 'completed';
}
