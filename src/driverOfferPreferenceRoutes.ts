import type { Express, Request, Response } from 'express';
import { getAdminAuth } from './firebaseAdmin';
import { driverOfferPreferencesInput, saveDriverOfferPreferences } from './driverOfferPreferences';

async function authenticatedDriverId(req: Request, response: Response) {
  const authorization = String(req.headers.authorization || '');
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!token) {
    response.status(401).json({ success: false, message: 'Please sign in again before saving Driver preferences.' });
    return null;
  }
  try {
    return (await getAdminAuth().verifyIdToken(token, true)).uid;
  } catch {
    response.status(401).json({ success: false, message: 'Your session has expired. Please sign in again.' });
    return null;
  }
}

export function registerDriverOfferPreferenceRoutes(app: Express) {
  app.put('/api/driver/offer-preferences', async (req, res) => {
    const driverId = await authenticatedDriverId(req, res);
    if (!driverId) return;
    const parsed = driverOfferPreferencesInput.safeParse(req.body?.preferences);
    if (!parsed.success) {
      res.status(400).json({ success: false, message: 'Driver preferences are invalid.' });
      return;
    }
    try {
      const preferences = await saveDriverOfferPreferences(driverId, parsed.data);
      res.status(200).json({ success: true, preferences });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'HY3N could not save your Driver preferences.';
      console.error('[DriverPreferences] Save failed:', { message });
      res.status(409).json({ success: false, message });
    }
  });
}
