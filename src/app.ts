import express, { Express } from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { z } from "zod";
import { registerHubtelWebhook } from "./hubtelWebhook";
import { registerPublicPaymentsApi } from "./publicPaymentsApi";
import { appRouter } from "./routers";
import { createContext } from "./context";
import newRouteRouter from "./newRoute";
import { registerCronRoutes } from "./cron";
import { adminFirestore, ADMIN_COLLECTIONS, getAdminAuth } from "./firebaseAdmin";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const rideLocationInput = z.object({
  lat: z.number().finite(),
  lng: z.number().finite(),
  name: z.string().min(1).max(160),
  address: z.string().min(1).max(300),
});

const riderRideRequestInput = z.object({
  riderId: z.string().min(1),
  riderName: z.string().min(1).max(120),
  riderPhone: z.string().max(40),
  riderEmail: z.string().max(254).optional(),
  category: z.string().min(1).max(50),
  pickup: rideLocationInput,
  destination: rideLocationInput,
  stops: z.array(rideLocationInput).max(3).optional(),
  payment: z.string().min(1).max(50),
  fare: z.number().finite().nonnegative(),
  baseFare: z.number().finite().nonnegative(),
  surgeMultiplier: z.number().finite().positive(),
  distance: z.number().finite().nonnegative(),
  duration: z.number().finite().nonnegative(),
  promoCode: z.string().max(50).optional(),
  discount: z.number().finite().nonnegative().optional(),
  rideOptions: z.object({
    ac: z.boolean(),
    pet_friendly: z.boolean(),
    extra_luggage: z.boolean(),
    wheelchair_accessible: z.boolean(),
  }).optional(),
});

/**
 * Builds the Express app. Shared by src/index.ts (local dev / a plain Node
 * server) and src/functions.ts (Firebase Cloud Functions) so the actual
 * routes/middleware are defined in exactly one place.
 */
export function createApp(): Express {
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

  // Request / Response Logger Middleware
  app.use((req, res, next) => {
    const start = Date.now();
    const { method, originalUrl } = req;

    const headers = { ...req.headers };
    if (headers.authorization) {
      headers.authorization = "[REDACTED]";
    }

    console.log(`[API Request] >>> ${method} ${originalUrl}`, JSON.stringify({
      timestamp: new Date().toISOString(),
      headers,
      query: req.query,
      body: req.body,
    }, null, 2));

    const originalSend = res.send;
    res.send = function (body) {
      const responseHeaders = res.getHeaders();
      let parsedBody = body;
      if (Buffer.isBuffer(body)) {
        parsedBody = "[BUFFER]";
      } else if (typeof body === 'string') {
        try {
          parsedBody = JSON.parse(body);
        } catch {
          parsedBody = body.length > 2000 ? body.substring(0, 2000) + '... [TRUNCATED]' : body;
        }
      }

      console.log(`[API Response] <<< ${method} ${originalUrl} | Status: ${res.statusCode} (Duration: ${Date.now() - start}ms)`, JSON.stringify({
        timestamp: new Date().toISOString(),
        headers: responseHeaders,
        body: parsedBody,
      }, null, 2));

      return originalSend.apply(this, arguments as any);
    };

    next();
  });

  registerHubtelWebhook(app);
  registerPublicPaymentsApi(app);
  app.use("/newroute", newRouteRouter);
  registerCronRoutes(app);

  /**
   * Creates a Rider request with Firebase ID-token authentication. A request
   * always remains unassigned until a real logged-in Driver explicitly accepts
   * it; the server must never assign a profile merely because it was last seen
   * as online.
   */
  app.post("/api/rides/request", async (req, res) => {
    const authHeader = String(req.headers.authorization || "");
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    if (!idToken) {
      res.status(401).json({ success: false, message: "Please sign in before requesting a ride." });
      return;
    }

    let tokenUid: string;
    try {
      tokenUid = (await getAdminAuth().verifyIdToken(idToken)).uid;
    } catch {
      res.status(401).json({ success: false, message: "Your session has expired. Please sign in again." });
      return;
    }

    const parsed = riderRideRequestInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, message: "Please check the ride details and try again." });
      return;
    }

    const input = parsed.data;
    if (input.riderId !== tokenUid) {
      res.status(403).json({ success: false, message: "You can only request a ride for your own account." });
      return;
    }

    try {
      const now = new Date().toISOString();
      const pickupCode = String(Math.floor(1000 + Math.random() * 9000));

      const ride = await adminFirestore.create(ADMIN_COLLECTIONS.RIDES, {
        rider_id: input.riderId,
        rider_name: input.riderName,
        rider_phone: input.riderPhone,
        rider_email: input.riderEmail || '',
        category: input.category,
        pickup: input.pickup,
        pickup_address: input.pickup.address || input.pickup.name,
        destination: input.destination,
        destination_address: input.destination.address || input.destination.name,
        stops: input.stops || [],
        payment: input.payment,
        payment_method: input.payment,
        fare: input.fare,
        fare_estimate: input.fare,
        base_fare: input.baseFare,
        surge_multiplier: input.surgeMultiplier,
        distance: input.distance,
        distance_km: input.distance,
        estimated_distance_km: input.distance,
        duration: input.duration,
        estimated_duration_minutes: input.duration,
        promo_code: input.promoCode || null,
        discount: input.discount || 0,
        ride_options: input.rideOptions || { ac: true, pet_friendly: false, extra_luggage: false, wheelchair_accessible: false },
        pickup_code: pickupCode,
        ride_pin: pickupCode,
        status: 'searching',
        driver_id: null,
        driver: null,
        driver_name: null,
        driver_vehicle: null,
        driver_plate: null,
        driver_colour: null,
        driver_colour_hex: null,
        matched_at: null,
        created_at: now,
      });

      res.status(201).json({
        success: true,
        ride,
        message: 'Your request is now waiting for a driver to accept it.',
      });
    } catch (error) {
      console.error('[Ride Dispatch] Failed to create rider request:', error);
      res.status(503).json({ success: false, message: 'Ride dispatch is temporarily unavailable. Please try again.' });
    }
  });

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
      console.log("[External API Request] >>> GET Google Places Autocomplete:", { url: url.replace(apiKey, "[REDACTED]") });
      const response = await fetch(url);
      const data = await response.json() as { status: string; predictions: any[] };
      console.log("[External API Response] <<< GET Google Places Autocomplete:", JSON.stringify(data, null, 2));

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
      const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(place_id)}&fields=name,formatted_address,geometry&key=${apiKey}`;
      console.log("[External API Request] >>> GET Google Place Details:", { url: url.replace(apiKey, "[REDACTED]") });
      const response = await fetch(url);
      const data = await response.json() as { status: string; result?: any };
      console.log("[External API Response] <<< GET Google Place Details:", JSON.stringify(data, null, 2));

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

  return app;
}
