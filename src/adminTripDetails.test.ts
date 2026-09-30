import { describe, expect, it } from 'vitest';
import { buildAdminTripDetail, rideParticipantIds } from './adminTripDetails';

describe('administrator trip details', () => {
  const ride = {
    id: 'ride_123',
    status: 'completed',
    rider_id: 'rider_123',
    rider_name: 'Rider Snapshot',
    rider_phone: '0244000000',
    driver_id: 'driver_123',
    driver_name: 'Driver Snapshot',
    driver_vehicle: 'Toyota Corolla',
    driver_plate: 'GR 1234-24',
    pickup: { address: 'Osu' },
    destination: { address: 'Kotoka Airport' },
    payment_method: 'wallet',
    final_fare: 32.5,
    matched_at: '2026-09-30T10:00:00.000Z',
    completed_at: '2026-09-30T10:30:00.000Z',
  };

  it('uses matched profile contacts and vehicle information for an admin-only dossier', () => {
    const detail = buildAdminTripDetail(
      ride,
      { full_name: 'Rider Profile', phone: '0244111111', email: 'rider@example.test', account_status: 'active', password_hash: 'never-return' },
      { full_name: 'Driver Profile', phone_number: '0244222222', email: 'driver@example.test', service_type: 'car', approval_status: 'approved', vehicle_make: 'Toyota', vehicle_model: 'Corolla', license_plate: 'GR 1234-24', id_document_url: 'never-return' },
    );

    expect(detail.trip).toMatchObject({ id: 'ride_123', pickupAddress: 'Osu', destinationAddress: 'Kotoka Airport', finalFare: 32.5 });
    expect(detail.rider).toMatchObject({ id: 'rider_123', name: 'Rider Profile', phone: '0244111111', email: 'rider@example.test' });
    expect(detail.driver).toMatchObject({ id: 'driver_123', name: 'Driver Profile', phone: '0244222222', vehicle: 'Toyota Corolla', plate: 'GR 1234-24', approvalStatus: 'approved' });
    expect(JSON.stringify(detail)).not.toContain('password_hash');
    expect(JSON.stringify(detail)).not.toContain('id_document_url');
  });

  it('does not invent a Driver dossier for an unassigned ride', () => {
    const detail = buildAdminTripDetail({ ...ride, driver_id: null, driver_name: null }, null, null);
    expect(detail.driver).toBeNull();
  });

  it('uses a legacy nested Driver snapshot when a profile or flat fields are absent', () => {
    const detail = buildAdminTripDetail({
      ...ride,
      driver_name: null,
      driver_vehicle: null,
      driver_plate: null,
      driver: { name: 'Nested Driver', phone: '0244333333', vehicle: 'Honda Civic', plate: 'GR 4321-25' },
    }, null, null);
    expect(detail.driver).toMatchObject({ name: 'Nested Driver', phone: '0244333333', vehicle: 'Honda Civic', plate: 'GR 4321-25' });
  });

  it('accepts only safe stored participant identifiers', () => {
    expect(rideParticipantIds({ rider_id: 'rider-1', driver_id: 'driver_1' })).toEqual({ riderId: 'rider-1', driverId: 'driver_1' });
    expect(rideParticipantIds({ rider_id: '../other', driver_id: '<script>' })).toEqual({ riderId: null, driverId: null });
  });
});
