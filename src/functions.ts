import { onRequest } from "firebase-functions/v2/https";
import { createApp } from "./app";

// Force deploy: 2026-07-18T17:10:00Z
// Same unhandledRejection/uncaughtException risk as src/index.ts applies here
// too — a detached credential-retry rejection would otherwise take down the
// whole function instance, not just the request that triggered it.
process.on("unhandledRejection", (reason) => {
  console.error("[fatal-guard] Unhandled rejection (instance staying up):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[fatal-guard] Uncaught exception (instance staying up):", err);
});

const app = createApp();

export const api = onRequest(
  {
    region: "europe-west1",
    // Mobile apps call this over plain HTTP with no Google-issued auth
    // token — 2nd gen functions require IAM invoker permission by default,
    // so without this every request gets a 403 before it ever reaches app.
    invoker: "public",
    // Routes ALL outbound traffic (not just requests to private/internal IP
    // ranges) through the hy3n-connector VPC connector -> hy3n-nat Cloud NAT
    // gateway, which always egresses through the static IP 35.189.197.39.
    // Needed so Hubtel can whitelist a single fixed IP for their Receive
    // Money API — without this, outbound calls use Google's shared,
    // unpredictable IP pool instead.
    vpcConnector: "hy3n-connector",
    vpcConnectorEgressSettings: "ALL_TRAFFIC",
    secrets: [
      "HUBTEL_API_ID",
      "HUBTEL_API_KEY",
      "HUBTEL_POS_NUMBER",
      "EMAIL_USER",
      "EMAIL_PASS",
      "ADMIN_DASHBOARD_PIN",
      "PUBLIC_PAYMENTS_API_USERNAME",
      "PUBLIC_PAYMENTS_API_PASSWORD",
      "GOOGLE_MAPS_API_KEY",
      "DAILY_COMMISSION_AMOUNT",
    ],
  },
  app,
);
