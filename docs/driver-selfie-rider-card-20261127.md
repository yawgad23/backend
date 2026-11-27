# HY3N — registered Driver selfie on the Rider card

**Prepared:** 27 November 2026  
**Status:** Source fix tested; not deployed. No mobile build started.  
**Repository:** `yawgad23/backend`  
**Branch:** `fix/driver-selfie-rider-card-20261127`  
**Base:** `79a7a4206f9193c8d85efc10a69715c51732e590`, the backend source associated with the last recorded API deployment, `api-00253-kig`. This is historical deployment evidence, not a fresh production readback.

## Problem and correction

Driver registration uploads “Your Photo (Selfie)” as `documents.profilePhoto`. The backend saves it as `profile_photo_url`. Previously, ride acceptance populated the assigned Driver's nested `photo_url` only from `avatar_url` or `photo_url`, omitting the registered selfie.

The assignment transaction now selects the current approved application’s `profile_photo_url` first and writes it to `ride.driver.photo_url`, which the existing Rider app already reads. Historical `avatar_url` and `photo_url` remain intentional fallbacks for existing approved profiles without a usable selfie. Invalid/local/non-string/credential-bearing photo values are ignored; an unavailable photo results in an empty photo URL, not an identity-document substitute.

The selection happens inside the same Firestore transaction that verifies approval and assigns the ride, including on transaction retries. A changed application that becomes pending/rejected, or a suspended account, cannot receive an assignment. A photo changed or removed before commit cannot leave the pretransaction photo in the assigned snapshot. Queued next rides use the same selection without rewriting the current ride.

Only the selected photo URL is added to the existing display-only Driver snapshot. The application profile is not spread into the ride. Ghana Card, licence, vehicle verification and other document fields are not added to the Rider payload. Storage/database rules and approval logic were not modified.

## Compatibility and scope

The inspected Android Rider source, `50846d6356e7a52323b203bf17b0cff2bf87e0c9`, accepts nested `driver.photo_url` and renders its Driver photo at 76 or 82 layout units depending on the card. Inspected iPhone source `30f03af8fc717bc2ebe08d6751606007a5e2fff3` has identical relevant home/recovery source. The correction therefore needs no mobile source change or new mobile build for these clients. Installed-device/store artifact provenance and actual on-device image loading were not retested.

After deployment, the correction applies to newly accepted rides, including queued rides. Existing accepted ride snapshots are not retroactively edited. No live ride, Driver photo, approval or account record was changed during this work.

Map, vehicle motion, camera, navigation, registration, Driver types, Call, request song, fees, and manual approval behavior remain unchanged. No app version was bumped. No deployment, store submission or paid build was started.

## Validation

- Full backend suite: **900 passed, 1 existing skipped, 0 failed** (901 total).
- Driver operational approval suite: **71 passed**, including **32 new photo regressions**.
- TypeScript `tsc --noEmit`: passed.
- `git diff --check`: passed.
- Existing Rider active-ride recovery suite: **9 passed**, including nested `photo_url` recovery.

The new regressions cover selfie precedence, legacy fallback, unavailable/invalid photo handling, returned/persisted/committed snapshot equality, queued rides, current-profile changes and transaction retries, approval revocation and suspension, and exclusion of nine canonical/legacy identity-document fields and their synthetic URL values. Tests use mocked services and synthetic photos; they do not prove a real production photo download succeeds.

## Next release step

The fix still requires an authorized backend API deployment before it is live. Deploy only the API, preserving the existing support-mailbox secret bindings and runtime configuration. Then verify a newly accepted test assignment with an approved Driver’s uploaded selfie in the Rider app. A mobile build and admin/dashboard deployment are not required for this mapping correction.
