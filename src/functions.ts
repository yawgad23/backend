import { onRequest } from "firebase-functions/v2/https";
import { createApp } from "./app";

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
    ],
  },
  app,
);
