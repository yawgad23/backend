# HY3N backend selfie acceptance simulation

**Result: passed.** The approved Driver's registration selfie reached the real local HTTP acceptance response, the committed synthetic ride snapshot, and the authenticated owning Rider's HTTP status response. Both unchanged Rider recovery helpers also retained that selfie.

Tested on 27 November 2026 using synthetic data only. No production trip, account, approval, document, notification, email, payment, deployment, or mobile build was created or changed.

## Source and scope

The simulation uses backend commit `72a66d7048db64029ad1012a6d7ef6a175b9c3d9`, the source previously verified against the deployed `api-00254-doy` revision. It runs in a separate tests-only worktree and branch, `test/driver-selfie-trip-simulation-20261127`, in `yawgad23/backend`. The original deployed-source worktree remains unchanged.

The new durable test is `src/driverSelfieTripSimulation.test.ts`. No production handler, runtime configuration, approval rule, native app source, map, audio, registration, or authentication-loading behavior was modified.

## Simulated flow

A synthetic Rider request is seeded as `searching`, with an unexpired offer for a synthetic approved Driver. Request creation is an in-memory fixture: the booking/quote endpoint itself is **not** exercised.

The local Express server is built by the real production `createApp()` and listens only on `127.0.0.1` at an ephemeral port. The test uses real HTTP through both production routes, not a replacement route or direct procedure caller:

1. The owning Rider reads `GET /api/rides/synthetic-selfie-trip/status` and receives `searching`, with no assigned Driver.
2. The Driver submits `POST /api/trpc/driverTrips.respondToOffer` with the accept decision. Production tRPC context, protected identity binding, approval logic, and acceptance transaction execute against mocked authentication and in-memory Firestore.
3. The response and committed ride become `driver_arriving` with the correct Driver ID.
4. The owning Rider reads the real status endpoint three times. Each response contains the same accepted Driver photo and unchanged assignment.
5. The accepted payload is passed into the unchanged Android and iPhone `recoverActiveRide` helpers. Both recover the Driver ID, `driver_arriving` status, and `driverPhoto` correctly without modifying the payload.

### Photo equality

The synthetic profile deliberately contains a registered selfie plus different legacy avatar and photo URLs. All three backend checkpoints equal the selfie, not either legacy image:

| Checkpoint | Verified photo |
|---|---|
| Acceptance response `ride.driver.photo_url` | `https://synthetic.invalid/registration-selfie.jpg` |
| Transaction write and persisted ride `driver.photo_url` | Same registration selfie |
| Owning Rider status response `ride.driver.photo_url` | Same registration selfie |
| Android recovered `driverPhoto` | Same registration selfie |
| iPhone recovered `driverPhoto` | Same registration selfie |

This URL is deliberately synthetic and is never downloaded. A further regression proves that a later profile-photo change does not silently rewrite the already accepted ride's photo snapshot.

## Privacy and authorization

The synthetic Driver profile contains fake Ghana Card, driving-licence, vehicle-photo, registration, insurance, and roadworthiness fields/URLs. None appears in the acceptance response, saved ride snapshot, or Rider status response. The profile is not spread into the public Driver card.

Pending, rejected, and suspended Drivers cannot assign themselves or expose their selfie, even with deliberately stale-approved presence and a synthetic in-memory fee waiver. A different authenticated UID cannot spoof the offered Driver ID (HTTP 403). Another approved Driver using their own correctly bound ID cannot steal the offer.

Anonymous and invalid-token Driver acceptances are denied with HTTP 401 before ride/profile reads or transaction writes. Anonymous and invalid-token Rider reads are also denied with HTTP 401. A different authenticated Rider receives the same generic HTTP 404 body as a missing ride: `Ride not found.` No photo or assignment is disclosed, and the stored trip is unchanged.

An unrelated existing API behavior was observed: approval/offer denials thrown as ordinary errors serialize as HTTP 500, although they correctly prevent assignment. This tests-only task preserves that existing behavior; it does not change error classification.

## Verification totals

| Verification | Result |
|---|---|
| New HTTP trip simulation | **12 passed; 0 failed; 0 skipped** |
| Simulation plus existing operational/approval/race suite | **83 passed; 0 failed** — 12 new plus 71 existing |
| Complete backend suite with new tests | **912 passed; 0 failed; 1 existing skipped** — 913 total |
| Backend TypeScript, `npm run check` | **Passed** |
| Android Rider recovery helper | **Passed** |
| iPhone Rider recovery helper | **Passed** |

The existing skipped test requires Google Maps credentials. No test was newly skipped, disabled, or removed.

Rider helper baselines:

- Android: `50846d6356e7a52323b203bf17b0cff2bf87e0c9`.
- iPhone: `30f03af8fc717bc2ebe08d6751606007a5e2fff3`.
- Both recovery source files have SHA-256 `b6151bc6cc416212830da42becc6cab97e4ae47240268df0d320fd1a51010d39`.

## Isolation and limits

Firebase token verification uses synthetic token-to-UID mappings. Firestore data and transactions exist only in memory. Storage, Firebase Messaging, real auth operations, and email delivery are guarded mocks that fail if used. Live Activity notification delivery is replaced with a local mock. External global fetch is deny-all; its invocation count is zero. Captured native fetch is restricted to the exact loopback origin/port and denies redirects.

This is a backend integration simulation with mocked services, **not a live Firebase end-to-end trip**. In-memory transaction behavior is not real Firestore contention; the existing 71-test authority/race suite was additionally run. The device image download, Storage URL accessibility, actual native rendering, background push delivery, and booking/payment path were not tested. No claim of phone-screen photo rendering is made.

The synthetic trace's `simulatedAt` value is a fixed test clock (`2026-11-27T18:00:00.000Z`), not the wall-clock time of execution.

## Reproduction and evidence

From the backend test branch, with dependencies installed:

```bash
SELFIE_SIMULATION_EVIDENCE_DIR=/absolute/path/to/evidence \
  npm test -- src/driverSelfieTripSimulation.test.ts --reporter=verbose
npm test -- src/driverSelfieTripSimulation.test.ts src/driverOperationalApproval.test.ts
npm run check
npm test
```

Evidence supplied alongside this report includes `flow-trace.json` (complete synthetic acceptance and owning-Rider response), the 12-test and 83-test logs, `full-suite-results.json`, the full-suite log, the TypeScript log, and `rider-recovery-results.json`. A local-only verification script and the compiled unchanged recovery helpers are included for reproducing the additional payload checks. The backend test has no dependency on mobile repository paths.

**Conclusion:** the simulated newly accepted ride delivers the approved registration selfie through the backend's Rider-facing payload, with no tested identity-document leakage or unauthorized photo access. No additional deployment or mobile build is needed for these test-only additions.
