type RecordLike = Record<string, unknown>;

function cleanText(value: unknown, maxLength = 160): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized ? normalized.slice(0, maxLength) : null;
}

function cleanId(value: unknown): string | null {
  const normalized = cleanText(value, 160);
  return normalized && /^[A-Za-z0-9_-]+$/.test(normalized) ? normalized : null;
}

function pickText(record: RecordLike | null | undefined, fields: string[], maxLength = 160): string | null {
  if (!record) return null;
  for (const field of fields) {
    const value = cleanText(record[field], maxLength);
    if (value) return value;
  }
  return null;
}

function pickupAddress(ride: RecordLike): string | null {
  const pickup = ride.pickup as RecordLike | undefined;
  return pickText(pickup, ['address', 'name'], 240)
    || pickText(ride, ['pickup_address', 'pickup_location', 'pickup_name'], 240);
}

function destinationAddress(ride: RecordLike): string | null {
  const destination = ride.destination as RecordLike | undefined;
  return pickText(destination, ['address', 'name'], 240)
    || pickText(ride, ['destination_address', 'dropoff_location', 'destination_name'], 240);
}

function money(value: unknown): number | null {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) / 100 : null;
}

function participant(
  role: 'rider' | 'driver',
  id: string | null,
  snapshot: RecordLike,
  profile: RecordLike | null,
) {
  const isDriver = role === 'driver';
  const nestedSnapshot = snapshot[role] && typeof snapshot[role] === 'object'
    ? snapshot[role] as RecordLike
    : null;
  const snapshotNameFields = isDriver ? ['driver_name'] : ['rider_name'];
  const snapshotPhoneFields = isDriver ? ['driver_phone'] : ['rider_phone'];
  const snapshotEmailFields = isDriver ? ['driver_email'] : ['rider_email'];
  const profilePhoneFields = ['phone', 'phone_number', 'mobile_number'];

  return {
    id,
    name: pickText(profile, ['full_name', 'name', 'display_name'], 120)
      || pickText(snapshot, snapshotNameFields, 120)
      || pickText(nestedSnapshot, ['full_name', 'name', 'display_name'], 120)
      || null,
    phone: pickText(profile, profilePhoneFields, 40)
      || pickText(snapshot, snapshotPhoneFields, 40)
      || pickText(nestedSnapshot, profilePhoneFields, 40)
      || null,
    email: pickText(profile, ['email'], 160)
      || pickText(snapshot, snapshotEmailFields, 160)
      || pickText(nestedSnapshot, ['email'], 160)
      || null,
    accountStatus: pickText(profile, ['account_status'], 32) || null,
    ...(isDriver ? {
      serviceType: pickText(profile, ['service_type', 'serviceType'], 48)
        || pickText(snapshot, ['vehicle_type', 'category'], 48)
        || null,
      approvalStatus: pickText(profile, ['approval_status'], 32) || null,
        vehicle: [
          pickText(profile, ['vehicle_year'], 12),
          pickText(profile, ['vehicle_make'], 60),
          pickText(profile, ['vehicle_model'], 60),
        ].filter(Boolean).join(' ') || pickText(snapshot, ['driver_vehicle'], 120) || pickText(nestedSnapshot, ['vehicle'], 120) || null,
        plate: pickText(profile, ['license_plate', 'vehicle_plate'], 40)
        || pickText(snapshot, ['driver_plate'], 40)
        || pickText(nestedSnapshot, ['plate', 'license_plate'], 40)
        || null,
    } : {}),
  };
}

/** Returns the privacy-minimized, administrator-only participant and trip dossier. */
export function buildAdminTripDetail(
  ride: RecordLike,
  riderProfile: RecordLike | null,
  driverProfile: RecordLike | null,
) {
  const riderId = cleanId(ride.rider_id ?? ride.riderId ?? ride.user_id);
  const driverId = cleanId(ride.driver_id ?? ride.driverId);
  const bookingForOther = ride.booking_for_other === true;

  return {
    trip: {
      id: cleanId(ride.id) || null,
      status: cleanText(ride.status, 32)?.toLowerCase() || 'unknown',
      category: cleanText(ride.category ?? ride.vehicle_type, 48) || null,
      paymentMethod: cleanText(ride.payment_display_name ?? ride.payment_method, 80) || null,
      pickupAddress: pickupAddress(ride),
      destinationAddress: destinationAddress(ride),
      createdAt: cleanText(ride.created_date ?? ride.created_at, 64) || null,
      matchedAt: cleanText(ride.matched_at ?? ride.driver_matched_at, 64) || null,
      arrivedAt: cleanText(ride.driver_arrived_at ?? ride.arrived_at, 64) || null,
      startedAt: cleanText(ride.started_at ?? ride.trip_started_at, 64) || null,
      completedAt: cleanText(ride.completed_at ?? ride.trip_completed_at, 64) || null,
      cancelledAt: cleanText(ride.cancelled_at, 64) || null,
      finalFare: money(ride.final_fare ?? ride.fare),
      bookingForOther,
      bookingContact: bookingForOther ? {
        name: pickText(ride, ['recipient_name', 'booked_for_name'], 120),
        phone: pickText(ride, ['recipient_phone', 'booked_for_phone'], 40),
      } : null,
    },
    rider: participant('rider', riderId, ride, riderProfile),
    driver: driverId ? participant('driver', driverId, ride, driverProfile) : null,
  };
}

export function rideParticipantIds(ride: RecordLike) {
  return {
    riderId: cleanId(ride.rider_id ?? ride.riderId ?? ride.user_id),
    driverId: cleanId(ride.driver_id ?? ride.driverId),
  };
}
