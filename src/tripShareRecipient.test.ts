import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sharing = readFileSync(resolve(process.cwd(), 'src/tripShare.ts'), 'utf8');
const push = readFileSync(resolve(process.cwd(), 'src/pushNotifications.ts'), 'utf8');
const functions = readFileSync(resolve(process.cwd(), 'src/functions.ts'), 'utf8');

describe('recipient-bound HY3N trip sharing', () => {
  it('binds an invitation to a claimed Rider account and an immutable assigned Driver', () => {
    expect(sharing).toContain("contactClaimDocumentId('rider', 'phone'");
    expect(sharing).toContain('recipient_uid: recipientUid');
    expect(sharing).toContain('assignment_driver_id: rideDriverId(currentRide)');
    expect(sharing).toContain('currentAssignmentMatches(share, ride)');
    expect(sharing).toContain('verifyIdToken(token, true)');
  });

  it('serves a private, no-store recipient snapshot rather than direct Firestore access', () => {
    expect(sharing).toContain("app.get('/api/trip-shares/:shareId/live'");
    expect(sharing).toContain("'Cache-Control', 'no-store, private'");
    expect(sharing).toContain("String(share.recipient_uid || '') !== recipientUid");
    expect(sharing).toContain('locationFromDriver(driver)');
    expect(sharing).toContain('LOCATION_FRESHNESS_MS');
  });

  it('sends an opaque push payload and ends shares after terminal or reassignment events', () => {
    expect(push).toContain("data: { type: 'trip_share', shareId: input.shareId }");
    expect(push).not.toContain("data: { type: 'trip_share', shareId: input.shareId, location");
    expect(functions).toContain("endActiveTripSharesForRide(event.params.rideId, 'ride_ended')");
    expect(functions).toContain("endActiveTripSharesForRide(event.params.rideId, 'assignment_changed')");
  });
});
