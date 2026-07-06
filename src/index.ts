import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerHubtelWebhook } from "./hubtelWebhook";
import { registerPublicPaymentsApi } from "./publicPaymentsApi";
import { appRouter } from "./routers";
import { createContext } from "./context";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Safety net: libraries like google-gax/google-auth-library sometimes schedule
// retry/token-refresh work on a detached tick, disconnected from the promise
// chain the original caller awaited — if that later rejects, Node treats it as
// fatal and kills the whole process by default. One bad Firestore credential
// lookup would otherwise take down every in-flight request, not just its own.
process.on("unhandledRejection", (reason) => {
  console.error("[fatal-guard] Unhandled rejection (server staying up):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[fatal-guard] Uncaught exception (server staying up):", err);
});

function startServer() {
  const app = express();

  // Enable CORS for all routes - reflect the request origin to support credentials
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      res.header("Access-Control-Allow-Origin", origin);
    }
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header(
      "Access-Control-Allow-Headers",
      "Origin, X-Requested-With, Content-Type, Accept, Authorization",
    );
    res.header("Access-Control-Allow-Credentials", "true");

    if (req.method === "OPTIONS") {
      res.sendStatus(200);
      return;
    }
    next();
  });

  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  registerHubtelWebhook(app);
  registerPublicPaymentsApi(app);

  // Google Places Autocomplete proxy — keeps API key server-side
  app.get("/api/places/autocomplete", async (req, res) => {
    const { input } = req.query as { input?: string };
    if (!input || input.trim().length < 2) {
      res.json({ predictions: [] });
      return;
    }
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: "Maps API key not configured" });
      return;
    }
    try {
      const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(input)}&key=${apiKey}&components=country:gh&language=en&types=geocode|establishment`;
      const response = await fetch(url);
      const data = await response.json() as { status: string; predictions: any[] };
      if (data.status === "OK" || data.status === "ZERO_RESULTS") {
        res.json({ predictions: data.predictions || [] });
      } else {
        res.json({ predictions: [] });
      }
    } catch (err) {
      res.json({ predictions: [] });
    }
  });

  // Google Place Details proxy — get lat/lng for a place_id
  app.get("/api/places/details", async (req, res) => {
    const { place_id } = req.query as { place_id?: string };
    if (!place_id) { res.json({ result: null }); return; }
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) { res.status(500).json({ error: "Maps API key not configured" }); return; }
    try {
      const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(place_id)}&key=${apiKey}&fields=name,formatted_address,geometry`;
      const response = await fetch(url);
      const data = await response.json() as { status: string; result?: any };
      res.json({ result: data.status === "OK" ? data.result : null });
    } catch {
      res.json({ result: null });
    }
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, timestamp: Date.now() });
  });

  app.get("/api/hubtel/status", (_req, res) => {
    res.json({ status: "ready", webhook: "/api/hubtel/callback" });
  });

  // Admin commission dashboard (served as static HTML)
  app.get("/admin/commission", (_req, res) => {
    res.sendFile(path.join(__dirname, "../public/admin-commission.html"));
  });

  // Admin PIN verification endpoint — PIN stored server-side as ADMIN_DASHBOARD_PIN env var
  app.post("/api/admin/verify-pin", (req, res) => {
    const { pin } = req.body as { pin?: string };
    const adminPin = process.env.ADMIN_DASHBOARD_PIN;
    if (!adminPin) {
      console.error("[Admin] ADMIN_DASHBOARD_PIN not configured");
      res.status(500).json({ ok: false, error: "Admin dashboard is not configured" });
      return;
    }
    if (!pin || pin !== adminPin) {
      res.status(401).json({ ok: false, error: "Invalid PIN" });
      return;
    }
    res.json({ ok: true });
  });

  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    }),
  );

  const port = parseInt(process.env.PORT || "3000", 10);
  app.listen(port, () => {
    console.log(`[api] server listening on port ${port}`);
  });
}

startServer();
