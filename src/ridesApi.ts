import { Router, Request, Response } from "express";
import { getAdminDb, ADMIN_COLLECTIONS } from "./firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";
import { sendTripReceiptEmail } from "./email";

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
    const { driverId, driverName, driverPhone, driverLocation, driverPlate, isQueued } = req.body;
    
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
      
      const updateData: any = {
        status: 'matched',
        driver_id: driverId,
        driver: driverObj,
        accepted_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp()
      };
      
      if (isQueued) {
        updateData.is_queued = true;
      }
      
      transaction.update(rideRef, updateData);
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
    const { status, driverLocation, pin } = req.body;
    
    const updateData: any = {
      status,
      updated_at: FieldValue.serverTimestamp()
    };
    
    if (driverLocation) {
      updateData.driver_location = driverLocation;
    }
    
    const db = getAdminDb();
    
    if (status === 'in_progress') {
      const rideDoc = await db.collection(ADMIN_COLLECTIONS.RIDES).doc(id).get();
      if (rideDoc.exists) {
        const ride = rideDoc.data();
        const expectedPin = ride?.ride_pin || ride?.ridePin;
        if (expectedPin && pin && String(expectedPin).trim() !== String(pin).trim()) {
          return res.status(400).json({ success: false, error: "Invalid ride PIN. Please check the 4-digit PIN with the rider." });
        }
      }
      updateData.started_at = FieldValue.serverTimestamp();
    }
    
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
            // Recalculate based on fraction of total distance covered
            const estimatedDistanceKm = ride?.distance || 1; // Fallback to 1 to avoid div by zero
            const originalFare = req.body.final_fare || ride?.fare_estimate || ride?.fare || 0;
            
            // If the calculated distKm is near or exceeds estimated distance, use full fare
            if (distKm >= estimatedDistanceKm * 0.9) {
               updateData.final_fare = originalFare;
            } else {
               const fraction = distKm / estimatedDistanceKm;
               // Never charge less than the minimum fare of 15 for a started ride
               updateData.final_fare = Math.max(15, originalFare * fraction);
            }
          }
        } else {
          updateData.final_fare = req.body.final_fare || ride?.fare_estimate || ride?.fare || 0;
        }
      }
    }
    
    await db.collection(ADMIN_COLLECTIONS.RIDES).doc(id).update(updateData);
    
    // If completed, send receipt and update driver stats
    if (status === 'completed') {
      try {
        const updatedRideDoc = await db.collection(ADMIN_COLLECTIONS.RIDES).doc(id).get();
        const rideData = updatedRideDoc.data();

        // Increment driver total trips
        if (rideData && rideData.driver_id) {
          await db.collection(ADMIN_COLLECTIONS.DRIVER_PROFILES).doc(rideData.driver_id).update({
            total_trips: FieldValue.increment(1)
          }).catch(e => console.error("[Rides API] Failed to increment driver trips:", e));
        }

        if (rideData && rideData.rider_id) {
          const riderDoc = await db.collection(ADMIN_COLLECTIONS.RIDER_PROFILES).doc(rideData.rider_id).get();
          const riderData = riderDoc.data();
          if (riderData && riderData.email) {
            const distKm = rideData.distance ? rideData.distance.toFixed(1) : 'Unknown';
            let durationMins = 'Unknown';
            if (rideData.started_at && rideData.completed_at) {
              const start = rideData.started_at.toDate ? rideData.started_at.toDate() : new Date(rideData.started_at);
              const end = rideData.completed_at.toDate ? rideData.completed_at.toDate() : new Date();
              durationMins = Math.round((end.getTime() - start.getTime()) / 60000).toString();
            }

            await sendTripReceiptEmail({
              riderEmail: riderData.email,
              riderName: riderData.full_name || 'Rider',
              driverName: rideData.driver_name || 'Driver',
              driverVehicle: rideData.vehicle_type || 'Vehicle',
              driverPlate: rideData.vehicle_plate || '',
              pickup: typeof rideData.pickup === 'string' ? rideData.pickup : rideData.pickup?.address || 'Pickup Location',
              destination: typeof rideData.destination === 'string' ? rideData.destination : rideData.destination?.address || 'Dropoff Location',
              distance: parseFloat(distKm) || 0,
              duration: parseInt(durationMins) || 0,
              fare: rideData.final_fare ? rideData.final_fare : (rideData.fare || 0),
              paymentMethod: rideData.payment_method || 'cash',
              tripId: id,
              completedAt: rideData.completed_at ? 
                (rideData.completed_at.toDate ? rideData.completed_at.toDate().toISOString() : new Date(rideData.completed_at).toISOString()) 
                : new Date().toISOString(),
              category: rideData.category || 'Standard'
            });
            console.log(`[Rides API] Receipt sent to ${riderData.email} for ride ${id}`);
          }
        }
      } catch (err: any) {
        console.error(`[Rides API] Error sending receipt for ride ${id}:`, err);
      }
    }
    
    console.log(`[Rides API] Ride ${id} status updated to ${status}`);
    res.json({ success: true, updatedData: updateData });
  } catch (error: any) {
    console.error(`[Rides API] Error updating ride status ${req.params.id}:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/rides/history/:riderId
 * Returns ride history for a specific rider, guaranteed server-side filtered by rider_id.
 * Uses Admin SDK so it bypasses client security rules entirely.
 */
router.get("/history/:riderId", async (req: Request, res: Response) => {
  try {
    const { riderId } = req.params;
    const limitNum = parseInt(req.query.limit as string) || 50;

    if (!riderId || riderId.length < 10) {
      res.status(400).json({ success: false, error: "Invalid riderId" });
      return;
    }

    const db = getAdminDb();
    const snap = await db
      .collection(ADMIN_COLLECTIONS.RIDES)
      .where("rider_id", "==", riderId)
      .orderBy("created_at", "desc")
      .limit(limitNum)
      .get();

    const rides = snap.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        ...data,
        // Normalize Firestore Timestamps to ISO strings for the client
        created_date: data.created_date?.toDate?.() ? data.created_date.toDate().toISOString() : data.created_date,
        created_at: data.created_at?.toDate?.() ? data.created_at.toDate().toISOString() : data.created_at,
        updated_date: data.updated_date?.toDate?.() ? data.updated_date.toDate().toISOString() : data.updated_date,
        completed_at: data.completed_at?.toDate?.() ? data.completed_at.toDate().toISOString() : data.completed_at,
      };
    });

    console.log(`[Rides API] Fetched ${rides.length} rides for rider ${riderId}`);
    res.json({ success: true, rides });
  } catch (error: any) {
    console.error(`[Rides API] Error fetching ride history for ${req.params.riderId}:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/rides/driver-history/:driverId
 * Returns ride history for a specific driver, guaranteed server-side filtered by driver_id.
 * Uses Admin SDK so it bypasses client security rules entirely.
 */
router.get("/driver-history/:driverId", async (req: Request, res: Response) => {
  try {
    const { driverId } = req.params;
    const limitNum = parseInt(req.query.limit as string) || 50;

    if (!driverId || driverId.length < 10) {
      res.status(400).json({ success: false, error: "Invalid driverId" });
      return;
    }

    const db = getAdminDb();
    const snap = await db
      .collection(ADMIN_COLLECTIONS.RIDES)
      .where("driver_id", "==", driverId)
      .orderBy("created_at", "desc")
      .limit(limitNum)
      .get();

    const rides = snap.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        ...data,
        // Normalize Firestore Timestamps to ISO strings for the client
        created_date: data.created_date?.toDate?.() ? data.created_date.toDate().toISOString() : data.created_date,
        created_at: data.created_at?.toDate?.() ? data.created_at.toDate().toISOString() : data.created_at,
        updated_date: data.updated_date?.toDate?.() ? data.updated_date.toDate().toISOString() : data.updated_date,
        completed_at: data.completed_at?.toDate?.() ? data.completed_at.toDate().toISOString() : data.completed_at,
      };
    });

    console.log(`[Rides API] Fetched ${rides.length} rides for driver ${driverId}`);
    res.json({ success: true, rides });
  } catch (error: any) {
    console.error(`[Rides API] Error fetching ride history for driver ${req.params.driverId}:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
