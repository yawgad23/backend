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
cp .env.example .env   # fill in real values
npm run dev            # tsx watch, listens on PORT (default 3000)
npm run check          # tsc --noEmit
```

## Build & deploy (Cloud Run)

```bash
npm run build           # esbuild -> dist/index.js
gcloud run deploy hy3n-api --source . --region <region> --allow-unauthenticated
```

Skip `FIREBASE_SERVICE_ACCOUNT` on Cloud Run — grant the service's runtime
service account the "Cloud Datastore User" IAM role instead and Application
Default Credentials will pick it up automatically (`src/firebaseAdmin.ts`
already falls back to ADC). Put the real secrets
(`HUBTEL_API_ID`/`HUBTEL_API_KEY`/`HUBTEL_POS_NUMBER`, `EMAIL_PASS`,
`ADMIN_DASHBOARD_PIN`, `PUBLIC_PAYMENTS_API_USERNAME`/`PASSWORD`,
`GOOGLE_MAPS_API_KEY`) in Secret Manager and mount them with
`--set-secrets`.

## Consuming from a mobile app

Add this repo as a dependency so `AppRouter` stays type-safe across repos:

```json
"dependencies": {
  "hy3n-backend": "github:yawgad23/backend"
}
```

```ts
import type { AppRouter } from "hy3n-backend/src/routers";
```

Set `EXPO_PUBLIC_API_BASE_URL` to the deployed Cloud Run URL.
