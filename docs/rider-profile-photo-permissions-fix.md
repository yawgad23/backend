# Rider build 133: server-only profile-photo save fix

**Status: prepared and emulator-tested; NOT deployed. No new native app build was started.**

Prepared on 22 November 2026 in the isolated backend checkout `/home/ubuntu/hy3n-backend-rider-photo-permissions`, branch `task/rider-photo-permissions-20261122`, based on remote main **`5d4ab31deacf4de99309c8de6337ad33b5bd7d1b`**. The only intended source changes are `firestore.rules`, `firebase.rider-photo.emulator.json`, `tests/rider-profile-photo.rules.emulator.mjs`, and this report. Native Rider, Storage rules, backend APIs, dependency manifests, production Firebase configuration and CI workflows are unchanged.

## Confirmed save-policy mismatch

Build 133 uploads to `rider_profiles/<authenticated UID>/profile.jpg`, obtains a download URL, then directly updates `rider_profiles/<loaded profile.id>` with `{ profile_picture: url, updated_date: new Date().toISOString() }`. Existing Firestore rules allow Rider profile updates only to admins. A legacy owned profile document ID may differ from the authenticated UID; this patch deliberately supports that case.

**GET-only live rule inspection at `2026-11-22T11:23:23.152Z`** confirmed the active policies. Recorded evidence is `/home/ubuntu/rider-photo-live-rules/inspection.json`. Firebase tracks each deployed policy as a release pointing to an immutable ruleset.[1]

The default Firestore release `projects/hy3n26/releases/cloud.firestore` points to `projects/hy3n26/rulesets/29edf104-5a0e-42c0-b04d-f8cecf5db59c`, last updated `2026-10-19T19:21:40.709802Z`. Its source SHA-256 is `6d5f0f4d52afc26d82a3304f7f68cf8b174f0cff3f1a38955ecdd2255b4cee91`.

The Storage release `projects/hy3n26/releases/firebase.storage/hy3n26.firebasestorage.app` points to `projects/hy3n26/rulesets/e4b78ef5-0433-439f-9ca8-557a2a0805e6`, last updated `2026-11-20T16:07:19.674786Z`. Its source SHA-256 is `3c1c4739fd3a1ec04dca6accef76b1c6ab717989f8fc1d8a71b4124c7a8f7456`.

Active Firestore source equals baseline commit `5d4ab31:firestore.rules`. Active Storage source equals this checkout's unchanged `storage.rules`: authenticated UID-owned Rider uploads are already allowed, with the existing 8 MiB JPEG/PNG/WebP policy. **No Storage change is needed for this Firestore save fix.** Live inspection is policy verification, not a live user upload/save trace. The plain permission alert and build133's awaited operation sequence identify the rejected Firestore save with high confidence; actual upload completion and this user's stored ownership have not been traced.

## Exact permission boundary

`safeRiderPhotoUpdate()` adds one non-admin exception to Rider **update** only. It requires existing `resource.data.user_id` to match the authenticated UID and the resulting `user_id` to remain unchanged. It uses `diff(...).affectedKeys().hasOnly(['profile_picture', 'updated_date'])`, so adding, modifying, or deleting every other field is denied, including nested fields.

The resulting photo value must be a string of at most 512 characters. The UID must match `[A-Za-z0-9_-]{1,128}`. The URL is split at `?`; its entire pre-query portion is compared **by exact string equality**, never a UID-interpolated regex:

```text
https://firebasestorage.googleapis.com/v0/b/hy3n26.firebasestorage.app/o/rider_profiles%2F<authenticated UID>%2Fprofile.jpg
```

The entire query must be exactly `alt=media&token=<36-character hyphenated hex UUID>`, with no extra parameters, reordered keys, fragment, whitespace, alternate origin/bucket/path, encoding substitutions, or trailing data. UUID hex may be upper- or lowercase. The local Firebase Storage SDK source confirms its `getDownloadURL` implementation encodes the complete object path and constructs `alt` followed by `token`; the tests use only a fake UUID, never a real download token. Nonstandard custom UIDs fail closed: this restriction prevents unsafe path/validation inputs, **not** bearer-URL leakage.

The resulting `updated_date` must be a 24-character UTC millisecond ISO-shaped string (`YYYY-MM-DDTHH:mm:ss.sssZ`), with bounded month/day/hour/minute/second components. This is shape/range validation only, not full calendar validation, freshness enforcement, or server audit evidence. The client may change one or both allowed fields if both resulting values are valid; build 133 sends both.

Admin read/create/update/delete branches are preserved. Non-admin create/delete remain denied. Names, contacts, identity aliases, financial data, status, roles, approvals, completion metadata and contact claim documents remain protected. The authenticated registration/contact APIs still own mandatory identity validation and uniqueness claims; this patch cannot create/complete an account or bypass their contact mutations.

## Actual emulator verification

**Final run: 190 passed, 0 failed; exit code 0.** These are HTTP requests evaluated by the real Firestore Rules emulator, not string inspection, mocked Firestore, or REST calls to production. Test fixtures are synthetic. The test helper uses unsigned JWTs in the Firebase SDK's emulator mock-token format; privileged `Bearer owner` is restricted to fixture setup, inspection and cleanup on the hardcoded local demo project.

Coverage includes canonical and owned legacy IDs; safe UID lengths 1 and 128; an owner with **no email claim**; valid build-133 photo/timestamp saves; preserved untouched fields; foreign/no-auth writes; canonical document IDs with foreign existing ownership; submitted ownership forgery; missing ownership; protected-field addition/modification/deletion; destructive full-document replacement; direct contact/name/financial saves; external/foreign/bucket/path/regex-UID attacks; malformed token/query/fragment/encoding; missing/non-string/oversized photo/timestamp values; invalid ISO components; create/delete denial; unchanged owner-email and active-admin privileges; inactive-admin denial; claim read/create/update/delete denial even to client admins; and no new Driver/wallet/unlisted-collection permissions.

The test refuses to run unless `FIRESTORE_EMULATOR_HOST` is exactly `127.0.0.1:8087`; explicit Google project environment variables, if present, must match `demo-hy3n-rider-photo`. Config starts **Firestore only**, on loopback port 8087 (websocket 9097, isolated hub/log ports 4407/4507), with UI disabled and no functions or Storage emulator. `emulators:exec` shut everything down; the test cleared its dedicated demo fixtures. No new packages were installed and no shared `node_modules` was modified. Existing Java 21 and cached Firestore emulator v1.22.0 were used.

### Portable rerun / future CI

From the backend repository root, with Node 18+ (tested Node 22), Java 21 and an available Firebase CLI:

```sh
CI=true FIREBASE_CLI_DISABLE_UPDATE_CHECK=true firebase emulators:exec \
  --config firebase.rider-photo.emulator.json \
  --project demo-hy3n-rider-photo \
  --only firestore \
  'node tests/rider-profile-photo.rules.emulator.mjs'
```

No rules-unit-testing package, application build, service account, production credentials or running backend is required. Port conflicts should be resolved before starting; do not substitute a production project. CI without a cached emulator may need to download the jar (the cached jar here is 136,707,194 bytes).

### Exact command executed here

```sh
cd /home/ubuntu/hy3n-website-visual-refresh && \
cd /home/ubuntu/hy3n-rider-xcode27-config && \
cd /home/ubuntu/hy3n-backend-rider-photo-permissions && \
CI=true FIREBASE_CLI_DISABLE_UPDATE_CHECK=true \
node /home/ubuntu/.npm/_npx/ba4f1959e38407b5/node_modules/firebase-tools/lib/bin/firebase.js \
  emulators:exec --config firebase.rider-photo.emulator.json \
  --project demo-hy3n-rider-photo --only firestore \
  'node tests/rider-profile-photo.rules.emulator.mjs' \
  > /home/ubuntu/rider-photo-rules-emulator-test.log 2>&1
```

Full final test log: `/home/ubuntu/rider-photo-rules-emulator-test.log`. Emulator diagnostic log: `/home/ubuntu/rider-photo-rules-firestore-debug.log`. These runtime logs are outside the source checkout and are not intended commit artifacts. `git diff --check` and `node --check tests/rider-profile-photo.rules.emulator.mjs` also passed. No build command was run.

## Release, rollback and remaining limits

**No deployment authorization has been exercised.** Source preparation is separate from production release, which requires explicit user confirmation. If authorized later, the narrowly scoped deployment command is:

```sh
firebase deploy --project hy3n26 --only firestore:rules
```

This command is documented only, **not executed**. Do not deploy indexes, functions, Storage or stale mobile rules. Re-check the active Firestore release immediately before rollout to avoid overwriting unrelated intervening policy changes. The verified pre-change rollback ruleset is `projects/hy3n26/rulesets/29edf104-5a0e-42c0-b04d-f8cecf5db59c`; preserve the matching original source/hash above and restore only the Firestore release if an explicitly authorized rollback is needed.

Emulator success does not establish live end-to-end resolution. After an approved rules-only rollout, an authorized build-133 test should confirm picker/crop, actual upload MIME, URL retrieval, persisted save after reload, and unchanged contact/name behavior. Other deployment systems and the native SDK migration are outside this patch.

**Privacy caveat:** the existing `getDownloadURL` value is a bearer-capability URL. Someone possessing a valid token URL may retrieve the image without the owner's Firebase session; authenticated Storage rules do not turn leaked download URLs into authenticated-only media. This patch adds no public read rule or bucket ACL, but cannot solve that existing capability-URL property. It also validates URL syntax/ownership path, not object existence, genuine token ownership, image contents or client-time authenticity. Stronger authenticated media delivery, server-owned audit timestamps, or backend object/token verification requires a separate API/client design, not this unchanged-build compatibility exception.

## References

[1]: https://firebase.google.com/docs/rules/manage-deploy "Firebase Security Rules management, selective deployment and release propagation"
