/**
 * Public Payments API
 *
 * Standalone REST endpoints (separate from the internal tRPC router in
 * routers.ts) that let *external* mobile app clients trigger a Hubtel Direct
 * Receive Money (mobile money) charge over plain HTTP + Basic Auth.
 *
 * This exists alongside `commission.charge` (tRPC) because that procedure is
 * only ever called by the HY3N apps themselves. Third-party clients need a
 * stable REST contract and their own credential pair, so charges initiated
 * here are tracked in the generic `payments` Firestore collection instead of
 * `daily_commissions`.
 *
 * Auth: every request must include `Authorization: Basic base64(username:password)`,
 * checked against PUBLIC_PAYMENTS_API_USERNAME / PUBLIC_PAYMENTS_API_PASSWORD.
 */
import type { Express, Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { z } from "zod";
import { chargeDriverCommission, getMomoChannel } from "./hubtel";
import { adminFirestore, ADMIN_COLLECTIONS } from "./firebaseAdmin";

// ─── Basic Auth ─────────────────────────────────────────────────────────────

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // Compare against a fixed-length buffer first so unequal lengths don't
  // short-circuit the comparison and leak length via timing.
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function requirePublicApiAuth(req: Request, res: Response, next: NextFunction) {
  const expectedUser = process.env.PUBLIC_PAYMENTS_API_USERNAME || "";
  const expectedPass = process.env.PUBLIC_PAYMENTS_API_PASSWORD || "";

  if (!expectedUser || !expectedPass) {
    console.error("[PublicPaymentsApi] PUBLIC_PAYMENTS_API_USERNAME/PUBLIC_PAYMENTS_API_PASSWORD not configured");
    res.status(500).json({ success: false, error: "Payments API is not configured" });
    return;
  }

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", 'Basic realm="HY3N Payments API"');
    res.status(401).json({ success: false, error: "Missing or invalid Authorization header" });
    return;
  }

  let decoded = "";
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    res.status(401).json({ success: false, error: "Malformed Authorization header" });
    return;
  }

  const sepIndex = decoded.indexOf(":");
  const user = sepIndex >= 0 ? decoded.slice(0, sepIndex) : decoded;
  const pass = sepIndex >= 0 ? decoded.slice(sepIndex + 1) : "";

  if (!timingSafeEqual(user, expectedUser) || !timingSafeEqual(pass, expectedPass)) {
    res.set("WWW-Authenticate", 'Basic realm="HY3N Payments API"');
    res.status(401).json({ success: false, error: "Invalid credentials" });
    return;
  }

  next();
}

// ─── Payload validation ─────────────────────────────────────────────────────

const chargeSchema = z.object({
  /** Amount in GH₵ */
  amount: z.number().positive(),
  /** Customer MoMo phone number, e.g. "0244123456" or "+233244123456" */
  customerMsisdn: z.string().min(9),
  /** Customer full name, shown on the USSD approval prompt */
  customerName: z.string().min(1),
  /** Shown on the USSD approval prompt, e.g. "HY3N wallet top-up" */
  description: z.string().min(1).max(150),
  /** MoMo network. Accepts "mtn" | "vodafone" | "tigo" | "airteltigo" (case-insensitive). Defaults to mtn. */
  network: z.string().optional(),
  /** Caller-supplied idempotency key. Auto-generated if omitted. */
  clientReference: z.string().min(1).max(64).optional(),
});

function formatMsisdn(input: string): string {
  const digits = input.replace(/[\s-]/g, "");
  if (digits.startsWith("+233")) return digits.slice(1);
  if (digits.startsWith("233")) return digits;
  if (digits.startsWith("0")) return "233" + digits.slice(1);
  return digits;
}

function generateReference(): string {
  return `hy3n-pub-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

export function registerPublicPaymentsApi(app: Express) {
  /**
   * POST /api/public/v1/payments/charge
   * Initiates a Hubtel mobile money charge. Async — the customer approves via
   * a USSD prompt, so the response status is "pending" until Hubtel's webhook
   * (or a subsequent GET .../status poll) confirms the final outcome.
   */
  app.post("/api/public/v1/payments/charge", requirePublicApiAuth, async (req: Request, res: Response) => {
    const parsed = chargeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: "Invalid payload",
        details: parsed.error.issues,
      });
      return;
    }

    const input = parsed.data;
    const clientReference = input.clientReference || generateReference();

    try {
      const existing = await adminFirestore.list(ADMIN_COLLECTIONS.PAYMENTS, { reference: clientReference });
      if (existing.length > 0) {
        res.status(409).json({
          success: false,
          error: "A payment with this clientReference already exists",
          clientReference,
        });
        return;
      }

      const channel = getMomoChannel(input.network || "mtn");
      const phone = formatMsisdn(input.customerMsisdn);

      const record = await adminFirestore.create(ADMIN_COLLECTIONS.PAYMENTS, {
        reference: clientReference,
        amount: input.amount,
        customer_msisdn: phone,
        customer_name: input.customerName,
        description: input.description,
        channel,
        status: "pending",
        source: "public_api",
      });

      // chargeDriverCommission is a generic Hubtel Direct Receive Money call —
      // the name is historical (it was written for the driver commission flow
      // first) but its request shape is plain customer/amount/reference fields.
      const result = await chargeDriverCommission({
        customerMsisdn: phone,
        amount: input.amount,
        customerName: input.customerName,
        description: input.description,
        clientReference,
        channel,
      });

      await adminFirestore.update(ADMIN_COLLECTIONS.PAYMENTS, record.id, {
        status: result.success ? "pending" : "failed",
        hubtel_transaction_id: result.transactionId || null,
        hubtel_message: result.message || null,
      });

      if (!result.success) {
        res.status(502).json({
          success: false,
          status: "failed",
          clientReference,
          message: result.message || "Hubtel rejected the charge request",
        });
        return;
      }

      res.status(202).json({
        success: true,
        status: "pending",
        transactionId: result.transactionId || null,
        clientReference,
        amount: input.amount,
        message: result.message || "Charge initiated. Customer will receive a USSD prompt to approve.",
      });
    } catch (err: any) {
      console.error("[PublicPaymentsApi] charge failed:", err?.message);
      res.status(500).json({ success: false, error: "Failed to process charge", message: err?.message });
    }
  });

  /**
   * GET /api/public/v1/payments/status?clientReference=...
   * Poll this until status moves from "pending" to "paid" or "failed".
   * Hubtel's webhook updates this record server-side as soon as the customer
   * approves/declines the USSD prompt — no need to poll faster than ~5s.
   */
  app.get("/api/public/v1/payments/status", requirePublicApiAuth, async (req: Request, res: Response) => {
    const clientReference = typeof req.query.clientReference === "string" ? req.query.clientReference : "";
    if (!clientReference) {
      res.status(400).json({ success: false, error: "clientReference query parameter is required" });
      return;
    }

    try {
      const matches = await adminFirestore.list(ADMIN_COLLECTIONS.PAYMENTS, { reference: clientReference });
      const record = matches[0];
      if (!record) {
        res.status(404).json({ success: false, error: "Unknown clientReference" });
        return;
      }

      res.json({
        success: true,
        clientReference: record.reference,
        status: record.status,
        amount: record.amount,
        transactionId: record.hubtel_transaction_id || null,
        message: record.hubtel_message || null,
        createdAt: record.created_date,
        updatedAt: record.updated_date,
      });
    } catch (err: any) {
      console.error("[PublicPaymentsApi] status lookup failed:", err?.message);
      res.status(500).json({ success: false, error: "Failed to look up payment status", message: err?.message });
    }
  });

  console.log("[PublicPaymentsApi] Registered POST /api/public/v1/payments/charge and GET /api/public/v1/payments/status");
}
