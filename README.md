# hy3n-backend

Shared Express + tRPC backend for the HY3N rider and driver mobile apps.
Extracted from the (now removed) `server/` directories that used to be
duplicated inside `hy3n-rider-mobile` and `hy3n-driver-mobile`.

## What it does

- tRPC API (`/api/trpc`) — trip receipt emails, Hubtel daily driver
  commission charges, rider/driver wallet top-up + settlement.
- Hubtel webhooks (`/api/hubtel/callback`, `/api/hubtel/wallet-callback`) —
  payment confirmation callbacks from Hubtel.
- Public payments REST API (`/api/public/v1/payments/*`) — Basic-Auth
  gated charge/status endpoints for external clients.
- Google Places autocomplete/details proxy (keeps the Maps API key
  server-side).
- Admin commission dashboard, served at `/admin/commission`, gated by a
  PIN checked at `POST /api/admin/verify-pin` (`ADMIN_DASHBOARD_PIN`).

Data lives entirely in Firestore (`src/firebaseAdmin.ts`) — there is no
SQL database.

## Auth model

There is no user-session/JWT layer in this backend. Every tRPC procedure
is `publicProcedure`; the mobile apps pass whatever IDs they need
(`riderId`, `driverId`, etc.) explicitly as input. The admin-only
commission endpoints are gated purely by the separate PIN check the
dashboard UI performs before it loads, not by per-request auth.

## Local development

```bash
npm install
cp .env.example .env.local   # NOT .env — see why below
npm run dev                  # tsx watch, listens on PORT (default 3000)
npm run check                # tsc --noEmit
```

Use `.env.local`, not `.env`, for anything local-only. Firebase Functions
deploys the contents of a bare `.env` as real production environment
variables — it is not a local-dev-only file the way it would be in most
other Node setups. `.env.local` is the Firebase-specific convention that's
loaded for local dev/emulator runs but never uploaded on `firebase deploy`.

Also don't set `PORT` in either file — it's a reserved variable name on both
Cloud Run and Firebase Functions; `src/index.ts` already defaults to 3000
when it's unset, and setting it yourself breaks Firebase's env-file loading.

The actual routes/middleware live in `src/app.ts` (`createApp()`), shared by:
- `src/index.ts` — plain Node server for local dev (`npm run dev`/`start`).
- `src/functions.ts` — Firebase Cloud Functions (2nd gen) entry point, used
  for the real deployment (see below).

## Deploy (Firebase Cloud Functions)

This deploys into the **same Firebase project the mobile apps already use**
(`hy3n26`, set as the default project in `.firebaserc`) — that's what gives
the function access to the same Firestore database without any extra
credential setup.

```bash
npm install -g firebase-tools   # if not already installed
firebase login                  # opens a browser — sign in with the Google
                                 # account that owns the hy3n26 Firebase project

# One-time: set the real secrets (never committed, stored in Secret Manager
# under the hood, injected as env vars at runtime — see the `secrets` list
# in src/functions.ts)
firebase functions:secrets:set HUBTEL_API_ID
firebase functions:secrets:set HUBTEL_API_KEY
firebase functions:secrets:set HUBTEL_POS_NUMBER
firebase functions:secrets:set EMAIL_USER
firebase functions:secrets:set EMAIL_PASS
firebase functions:secrets:set ADMIN_DASHBOARD_PIN
firebase functions:secrets:set PUBLIC_PAYMENTS_API_USERNAME
firebase functions:secrets:set PUBLIC_PAYMENTS_API_PASSWORD
firebase functions:secrets:set GOOGLE_MAPS_API_KEY

firebase deploy --only functions
```

`firebase.json`'s `predeploy` hook runs `npm run build:functions` (esbuild
bundle of `src/functions.ts`) automatically before every deploy.

`EMAIL_HOST`/`EMAIL_PORT`/`EMAIL_FROM` aren't in the `secrets` list — they
already default to sensible values in `src/email.ts` (Gmail SMTP,
`smtp.gmail.com:465`) with no secret content, so nothing to configure for
those in production. `EMAIL_USER` *is* in the `secrets` list even though a
Gmail address isn't really sensitive — it's just simplest to set it
alongside `EMAIL_PASS` since they're used together.

The deployed URL looks like
`https://europe-west1-hy3n26.cloudfunctions.net/api` — note the function is
named `api`, and this app's own routes all start with `/api/...` too, so the
full paths end up double-nested, e.g.
`.../api/api/trpc/commission.getStatus`. That's expected — set
`EXPO_PUBLIC_API_BASE_URL` to `https://europe-west1-hy3n26.cloudfunctions.net/api`
(the function's base URL) and the mobile apps' existing `/api/trpc/...`
paths resolve correctly against it.

Test locally against the Firebase emulator before deploying for real:

```bash
firebase emulators:start --only functions
curl http://127.0.0.1:5001/hy3n26/europe-west1/api/api/health
```

## Consuming from a mobile app

Add this repo as a dependency so `AppRouter` stays type-safe across repos:

```json
"dependencies": {
  "hy3n-backend": "github:yawgad23/backend"
}
```

```ts
import type { AppRouter } from "hy3n-backend";
```

`dist-types/*.d.ts` is committed to this repo (unlike `dist/`, which is
build output) — consumers type-check against those declarations, never the
raw `src/*.ts`. This matters: importing raw source across repos would force
the consumer's `tsc` to fully resolve this package's *entire* implementation
(including internal-only dependencies like `nodemailer`) just to compute
`AppRouter`, leaking backend-only devDependencies into the mobile apps.

**If you change anything under `src/`, run `npm run build:types` and commit
the resulting `dist-types/` changes in the same commit** — there's no
install-time hook regenerating it for consumers (git-dependency `prepare`
scripts turned out not to run reliably here).

Set `EXPO_PUBLIC_API_BASE_URL` to the deployed Cloud Run URL.
