import { Router, Request, Response } from "express";
import { getAdminDb, ADMIN_COLLECTIONS } from "./firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";

const router: Router = Router();

// Middleware to log all ride API requests
router.use((req, res, next) => {
  console.log(`[Rides API] ${req.method} ${req.originalUrl}`);
  console.log(`[Rides API] Body:`, JSON.stringify(req.body, null, 2));
  next();
});

// Helper to calculate distance in km between two coordinates
function getDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371; 
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

/**
 * POST /api/rides/request
 * Creates a new ride request from the Rider app.
 */
router.post("/request", async (req: Request, res: Response) => {
  try {
    const db = getAdminDb();
    const rideData = req.body;
    
    // Server-side validation and timestamping
    rideData.created_at = FieldValue.serverTimestamp();
    rideData.status = 'searching';
    
    const docRef = await db.collection(ADMIN_COLLECTIONS.RIDES).add(rideData);
    
    console.log(`[Rides API] Successfully created ride ${docRef.id}`);
    res.json({ success: true, rideId: docRef.id });
  } catch (error: any) {
    console.error("[Rides API] Error requesting ride:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/rides/:id/cancel
 * Cancels a ride.
 */
router.post("/:id/cancel", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { reason, cancelledBy } = req.body;
    
    const db = getAdminDb();
    await db.collection(ADMIN_COLLECTIONS.RIDES).doc(id).update({
      status: 'cancelled',
      cancel_reason: reason || 'Cancelled via API',
      cancelled_by: cancelledBy || 'rider',
      updated_at: FieldValue.serverTimestamp()
    });
    
    console.log(`[Rides API] Successfully cancelled ride ${id}`);
    res.json({ success: true });
  } catch (error: any) {
    console.error(`[Rides API] Error cancelling ride ${req.params.id}:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/rides/:id/accept
 * Driver accepts a ride.
 */
router.post("/:id/accept", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { driverId, driverName, driverPhone, driverLocation, driverPlate } = req.body;
    
    const db = getAdminDb();
    
    // We should use a transaction to ensure we don't assign two drivers to the same ride
    await db.runTransaction(async (transaction) => {
      const rideRef = db.collection(ADMIN_COLLECTIONS.RIDES).doc(id);
      const rideDoc = await transaction.get(rideRef);
      
      if (!rideDoc.exists) {
        throw new Error("Ride does not exist.");
      }
      
      const data = rideDoc.data();
      if (data?.status !== 'searching') {
        throw new Error("Ride is no longer available.");
      }
      
      // Fetch the driver profile to attach complete driver details to the ride document
      const driverRef = db.collection(ADMIN_COLLECTIONS.DRIVER_PROFILES).doc(driverId);
      const driverDoc = await transaction.get(driverRef);
      const driverProfile = driverDoc.data();
      
      const driverObj = {
        id: driverId,
        name: driverProfile?.full_name || driverName || 'Driver',
        phone: driverProfile?.phone || driverPhone || '',
        vehicle_make: driverProfile?.vehicle_make || '',
        vehicle_model: driverProfile?.vehicle_model || '',
        plate: driverProfile?.vehicle_plate || driverPlate || '',
        rating: driverProfile?.rating || 5.0,
        total_trips: driverProfile?.total_trips || 0,
        vehicle_colour: driverProfile?.vehicle_colour || 'Black',
        vehicle_colour_hex: driverProfile?.vehicle_colour_hex || '#000000',
        location: driverLocation || null
      };
      
      transaction.update(rideRef, {
        status: 'matched',
        driver_id: driverId,
        driver: driverObj,
        accepted_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp()
      });
    });
    
    console.log(`[Rides API] Driver ${driverId} successfully accepted ride ${id}`);
    res.json({ success: true });
  } catch (error: any) {
    console.error(`[Rides API] Error accepting ride ${req.params.id}:`, error);
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/rides/:id/decline
 * Driver declines a ride.
 */
router.post("/:id/decline", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { driverId } = req.body;
    
    const db = getAdminDb();
    await db.collection(ADMIN_COLLECTIONS.RIDES).doc(id).update({
      declined_by: FieldValue.arrayUnion(driverId),
      updated_at: FieldValue.serverTimestamp()
    });
    
    console.log(`[Rides API] Driver ${driverId} declined ride ${id}`);
    res.json({ success: true });
  } catch (error: any) {
    console.error(`[Rides API] Error declining ride ${req.params.id}:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/rides/:id/status
 * Driver updates the status of the ride (driver_arriving, driver_arrived, in_progress, completed).
 */
router.post("/:id/status", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status, driverLocation } = req.body;
    
    const updateData: any = {
      status,
      updated_at: FieldValue.serverTimestamp()
    };
    
    if (driverLocation) {
      updateData.driver_location = driverLocation;
    }
    
    const db = getAdminDb();
    
    if (status === 'completed') {
      updateData.completed_at = FieldValue.serverTimestamp();
      
      // Prevent full fare charge if trip was ended without moving
      const rideDoc = await db.collection(ADMIN_COLLECTIONS.RIDES).doc(id).get();
      if (rideDoc.exists) {
        const ride = rideDoc.data();
        const currentLoc = driverLocation || ride?.driver_location;
        const pickupLoc = ride?.pickup;
        
        if (currentLoc && pickupLoc) {
          const distKm = getDistanceKm(pickupLoc.lat, pickupLoc.lng, currentLoc.lat, currentLoc.lng);
          
          if (distKm < 0.2) {
            // Driver barely moved from pickup (less than 200m). Charge minimum base fare.
            updateData.final_fare = 15; 
          } else {
            updateData.final_fare = req.body.final_fare || ride?.fare_estimate || 0;
          }
        } else {
          updateData.final_fare = req.body.final_fare || ride?.fare_estimate || 0;
        }
      }
    }
    
    await db.collection(ADMIN_COLLECTIONS.RIDES).doc(id).update(updateData);
    
    console.log(`[Rides API] Ride ${id} status updated to ${status}`);
    res.json({ success: true });
  } catch (error: any) {
    console.error(`[Rides API] Error updating ride status ${req.params.id}:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
