import { Router, Request, Response } from "express";

const router = Router();
const TARGET_URL = "https://webhook.site/f602e639-51c9-4c81-992a-c412fa10bd38";

router.all("*", async (req: Request, res: Response) => {
  try {
    const method = req.method;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    // Forward relevant query string parameters if any
    const url = new URL(TARGET_URL);
    for (const [key, val] of Object.entries(req.query)) {
      if (typeof val === "string") {
        url.searchParams.append(key, val);
      } else if (Array.isArray(val)) {
        for (const item of val) {
          if (typeof item === "string") {
            url.searchParams.append(key, item);
          }
        }
      }
    }

    
    const options: RequestInit = {
      method,
      headers,
    };

    // Forward request body for non-GET/HEAD methods
    if (method !== "GET" && method !== "HEAD" && req.body) {
      options.body = JSON.stringify(req.body);
    }

    console.log(`[NewRoute] Forwarding something ${method} request to ${TARGET_URL}`);
    const response = await fetch(url.toString(), options);
    const responseText = await response.text();

    res.status(response.status).send(responseText);
  } catch (err: any) {
    console.error("[NewRoute] Error forwarding request:", err?.message);
    res.status(500).json({
      success: false,
      error: "Failed to forward request to webhook.site",
      message: err?.message,
    });
  }
});

export default router;
