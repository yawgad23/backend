import { describe, it, expect } from "vitest";

describe("Google Maps API Key", () => {
  it.skipIf(!process.env.GOOGLE_MAPS_API_KEY)("should return valid Places autocomplete results for Ghana when API credentials are configured", async () => {
    const key = process.env.GOOGLE_MAPS_API_KEY;
    const res = await fetch(
      `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=Accra+Mall&key=${key}&components=country:gh`
    );
    const data = await res.json();
    expect(data.status).toBe("OK");
    expect(data.predictions.length).toBeGreaterThan(0);
    expect(data.predictions[0].description).toContain("Ghana");
  });
});
