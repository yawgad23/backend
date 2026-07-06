# HY3N Public Payments API — React Native Integration Guide

This document describes how to integrate **any** React Native (or other mobile)
app with HY3N's public payments REST API. The API is a thin, authenticated
wrapper around Hubtel's **Direct Receive Money** (mobile money) product —
your app calls one endpoint to request a charge, the customer approves a USSD
prompt on their phone, and you poll (or receive a webhook relay, if you set
one up with HY3N) for the final result.

This is **not** the same thing as the internal `commission.charge` tRPC
procedure used by the HY3N driver app itself (`server/routers.ts`) — that one
is session/cookie-based and only callable from within that app. This API is
for external clients and uses HTTP Basic Auth with its own credential pair.

---

## 1. Base URL

```
https://<your-deployed-api-host>/api/public/v1/payments
```

For local development against the server in this repo: `http://localhost:3000/api/public/v1/payments`.

There are two endpoints:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/charge` | Initiate a mobile money charge |
| `GET` | `/status?clientReference=...` | Poll the outcome of a charge |

---

## 2. Authentication

Every request must include an HTTP Basic Auth header:

```
Authorization: Basic base64(username:password)
```

Credentials are issued out-of-band by HY3N (see `PUBLIC_PAYMENTS_API_USERNAME`
/ `PUBLIC_PAYMENTS_API_PASSWORD` on the server side) — they are **not** the
same as Hubtel's own merchant API credentials, and not the same as any
Firebase/end-user auth token your app may already use elsewhere.

Missing or invalid credentials return `401 Unauthorized` with a
`WWW-Authenticate: Basic` header.

**Security note:** Basic Auth credentials embedded in a mobile app binary can
be extracted by a sufficiently motivated attacker (the app ships the secret to
every device). This is acceptable for a low-volume B2B/partner integration
where the credential identifies *which partner app* is calling, not an
individual end user — it is not a substitute for end-user authentication, and
the credential should be rotated immediately if you suspect it has leaked.
Always call this API over HTTPS in production; never log the raw header.

---

## 3. POST `/charge`

Initiates a Hubtel mobile money charge. The call is **asynchronous**: Hubtel
sends a USSD prompt to the customer's phone, and the customer must approve it
there. The HTTP response only tells you whether Hubtel *accepted the request*
— not whether the customer actually paid. Use the `clientReference` returned
to poll `GET /status` afterwards.

### Request

```http
POST /api/public/v1/payments/charge
Authorization: Basic <credentials>
Content-Type: application/json
```

```json
{
  "amount": 50,
  "customerMsisdn": "0244123456",
  "customerName": "John Doe",
  "description": "HY3N wallet top-up",
  "network": "mtn",
  "clientReference": "myapp-topup-00123"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `amount` | number | yes | Amount in GH₵. Must be > 0. |
| `customerMsisdn` | string | yes | Customer's MoMo number. Accepts `0XXXXXXXXX`, `233XXXXXXXXX`, or `+233XXXXXXXXX` — normalized server-side to `233XXXXXXXXX`. |
| `customerName` | string | yes | Shown on the USSD approval prompt. |
| `description` | string | yes | Shown on the USSD approval prompt. Max 150 chars. |
| `network` | string | no | `"mtn"` \| `"vodafone"` \| `"tigo"` \| `"airteltigo"` (case-insensitive, also accepts `"telecel"`/`"at"`). Defaults to `mtn`. |
| `clientReference` | string | no | Your own idempotency key, max 64 chars. If you reuse one that's already on file, the request is rejected with `409` instead of double-charging. If omitted, the server generates one (returned in the response) — **save it**, you need it to poll status. |

### Response — `202 Accepted` (Hubtel accepted the charge request)

```json
{
  "success": true,
  "status": "pending",
  "transactionId": "11d4d6c2-...",
  "clientReference": "myapp-topup-00123",
  "amount": 50,
  "message": "Charge initiated. Customer will receive a USSD prompt to approve."
}
```

### Response — `400 Bad Request` (validation failed)

```json
{
  "success": false,
  "error": "Invalid payload",
  "details": [ /* per-field zod validation issues */ ]
}
```

### Response — `401 Unauthorized`

```json
{ "success": false, "error": "Invalid credentials" }
```

### Response — `409 Conflict` (duplicate `clientReference`)

```json
{
  "success": false,
  "error": "A payment with this clientReference already exists",
  "clientReference": "myapp-topup-00123"
}
```

### Response — `502 Bad Gateway` (Hubtel rejected the charge)

```json
{
  "success": false,
  "status": "failed",
  "clientReference": "myapp-topup-00123",
  "message": "<Hubtel's error message, e.g. invalid phone number, IP not whitelisted, etc.>"
}
```

### Response — `500 Internal Server Error`

Server-side failure unrelated to your input (e.g. database unavailable).
Safe to retry with the same `clientReference` after a short delay.

---

## 4. GET `/status`

Poll this after a successful `POST /charge` to find out whether the customer
approved or declined the USSD prompt.

### Request

```http
GET /api/public/v1/payments/status?clientReference=myapp-topup-00123
Authorization: Basic <credentials>
```

### Response — `200 OK`

```json
{
  "success": true,
  "clientReference": "myapp-topup-00123",
  "status": "paid",
  "amount": 50,
  "transactionId": "11d4d6c2-...",
  "message": "Success",
  "createdAt": "2026-06-23T10:15:00.000Z",
  "updatedAt": "2026-06-23T10:15:42.000Z"
}
```

`status` is one of:

| Value | Meaning |
|---|---|
| `pending` | Hubtel accepted the request; customer hasn't responded to the USSD prompt yet. Keep polling. |
| `paid` | Customer approved. Money received. Terminal state. |
| `failed` | Customer declined, the prompt timed out, or Hubtel rejected the charge. Terminal state. |

### Response — `404 Not Found`

```json
{ "success": false, "error": "Unknown clientReference" }
```

### Polling guidance

- Poll every **5–10 seconds**. The USSD approval flow typically resolves in
  under a minute; Hubtel's webhook updates the status server-side as soon as
  the customer responds, so there's no benefit to polling faster.
- Stop polling once `status` is `paid` or `failed` (terminal states).
- If `status` is still `pending` after ~2 minutes, treat it as likely
  abandoned/timed out and let the user retry with a new `clientReference`.

---

## 5. React Native example

```ts
// payments.ts
const API_BASE = "https://<your-deployed-api-host>/api/public/v1/payments";
const AUTH_HEADER =
  "Basic " + btoa(`${PUBLIC_PAYMENTS_USERNAME}:${PUBLIC_PAYMENTS_PASSWORD}`);
// btoa is available in Hermes/RN >= 0.74. On older RN, use a base64 polyfill
// (e.g. `react-native-base64` or `Buffer.from(str).toString('base64')` from
// the `buffer` package) instead of `btoa`.

export interface ChargeResult {
  success: boolean;
  status: "pending" | "failed";
  transactionId: string | null;
  clientReference: string;
  amount: number;
  message: string;
}

export async function chargeMobileMoney(params: {
  amount: number;
  customerMsisdn: string;
  customerName: string;
  description: string;
  network?: "mtn" | "vodafone" | "tigo" | "airteltigo";
  clientReference?: string;
}): Promise<ChargeResult> {
  const response = await fetch(`${API_BASE}/charge`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: AUTH_HEADER,
    },
    body: JSON.stringify(params),
  });

  const data = await response.json();
  if (!response.ok && response.status !== 502) {
    throw new Error(data.message || data.error || `HTTP ${response.status}`);
  }
  return data as ChargeResult;
}

export interface PaymentStatus {
  success: boolean;
  clientReference: string;
  status: "pending" | "paid" | "failed";
  amount: number;
  transactionId: string | null;
  message: string | null;
}

export async function getPaymentStatus(clientReference: string): Promise<PaymentStatus> {
  const response = await fetch(
    `${API_BASE}/status?clientReference=${encodeURIComponent(clientReference)}`,
    { headers: { Authorization: AUTH_HEADER } },
  );
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data as PaymentStatus;
}

/** Polls until the payment reaches a terminal state, or `timeoutMs` elapses. */
export async function waitForPayment(
  clientReference: string,
  { intervalMs = 5000, timeoutMs = 120000 } = {},
): Promise<PaymentStatus> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await getPaymentStatus(clientReference);
    if (status.status === "paid" || status.status === "failed") {
      return status;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("Payment timed out waiting for customer approval");
}
```

Usage in a component:

```ts
const result = await chargeMobileMoney({
  amount: 50,
  customerMsisdn: "0244123456",
  customerName: "John Doe",
  description: "HY3N wallet top-up",
  network: "mtn",
});

if (result.status === "failed") {
  // Hubtel rejected the request outright (bad number, IP not whitelisted, etc.)
  Alert.alert("Payment failed", result.message);
} else {
  Alert.alert("Approve on your phone", "Check your phone for the USSD prompt.");
  const final = await waitForPayment(result.clientReference);
  if (final.status === "paid") {
    Alert.alert("Payment received");
  } else {
    Alert.alert("Payment not completed", final.message ?? "");
  }
}
```

---

## 6. Phone number format

Send the number in any of these forms — the server normalizes it:

- `0244123456` (local format)
- `233244123456` (country code, no `+`)
- `+233244123456`

All are converted to `233244123456` before being sent to Hubtel.

---

## 7. Server-side configuration (for the HY3N backend team)

These environment variables must be set wherever `server/_core/index.ts` runs:

```bash
PUBLIC_PAYMENTS_API_USERNAME=<issued to the partner app>
PUBLIC_PAYMENTS_API_PASSWORD=<strong random secret>
HUBTEL_POS_NUMBER=<merchant POS number>
HUBTEL_API_ID=<Hubtel API ID>
HUBTEL_API_KEY=<Hubtel API key>
```

If `PUBLIC_PAYMENTS_API_USERNAME`/`PASSWORD` are unset, every request to
`/api/public/v1/payments/*` returns `500` with `"Payments API is not
configured"`. If the Hubtel credentials are unset, `POST /charge` returns
`502` with `"Payment provider is not configured."`.

Implementation lives in:
- `src/publicPaymentsApi.ts` — the two REST routes + Basic Auth middleware.
- `server/_core/hubtelWebhook.ts` — receives Hubtel's async payment-result
  callback and updates the `payments` Firestore collection that `/status` reads from.
- `server/hubtel.ts` — low-level Hubtel Direct Receive Money API client.

Each charge is recorded in the `payments` Firestore collection with a
`source: "public_api"` field, distinguishing it from driver-commission charges
(`daily_commissions` collection) so the two flows never collide even though
they share the same underlying Hubtel account.
