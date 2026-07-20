import { onDocumentCreated, onDocumentUpdated } from "firebase-functions/v2/firestore";
import { Expo } from 'expo-server-sdk';
import { getAdminDb } from './firebaseAdmin';

const expo = new Expo();

export const notifyDriversOnRideCreated = onDocumentCreated(
  { document: "rides/{rideId}", region: "europe-west1" },
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;
    
    const ride = snapshot.data();
    if (ride.status !== 'searching') return;
    
    const db = getAdminDb();
    
    // Find nearby available drivers
    const driversRef = db.collection('driver_profiles');
    let query = driversRef.where('is_available', '==', true);
    
    const availableDrivers = await query.get();
    
    // Read dispatch radius from settings (default 10km)
    let maxRadiusKm = 10;
    const settingsDoc = await db.collection('settings').doc('dispatch').get();
    if (settingsDoc.exists) {
      const s = settingsDoc.data();
      if (s && typeof s.max_dispatch_radius_km === 'number') {
        maxRadiusKm = s.max_dispatch_radius_km;
      }
    }
    
    // Helper function for Haversine distance
    const getDistanceFromLatLonInKm = (lat1: number, lon1: number, lat2: number, lon2: number) => {
      const R = 6371; // Radius of the earth in km
      const dLat = (lat2 - lat1) * (Math.PI / 180);
      const dLon = (lon2 - lon1) * (Math.PI / 180);
      const a = 
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * 
        Math.sin(dLon / 2) * Math.sin(dLon / 2); 
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); 
      return R * c; // Distance in km
    };
    
    const messages: any[] = [];
    const rideLat = ride.ridePin?.latitude || ride.ridePin?.lat;
    const rideLng = ride.ridePin?.longitude || ride.ridePin?.lng;
    
    for (const doc of availableDrivers.docs) {
      const driver = doc.data();
      
      // Filter by category in memory since driver may have an array of accepted_categories
      const categoryId = (ride.category || ride.categoryId || '').toLowerCase();
      if (categoryId) {
        const accepted = driver.accepted_categories || [];
        const driverMainCat = (driver.category || '').toLowerCase();
        if (driverMainCat !== categoryId && (!Array.isArray(accepted) || !accepted.includes(categoryId))) {
          continue; // Driver does not accept this category
        }
      }
      
      // If we have coordinates, check radius
      if (rideLat && rideLng && driver.lat && driver.lng) {
        const distance = getDistanceFromLatLonInKm(rideLat, rideLng, driver.lat, driver.lng);
        if (distance > maxRadiusKm) {
          continue; // Skip this driver, they are too far
        }
      }
      
      if (driver.push_token && Expo.isExpoPushToken(driver.push_token)) {
        messages.push({
          to: driver.push_token,
          sound: 'default',
          title: '🚗 New Ride Request!',
          body: 'A rider is looking for a driver nearby.',
          data: { rideId: snapshot.id, type: 'new_ride' },
        });
      }
    }
    
    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      try {
        await expo.sendPushNotificationsAsync(chunk);
      } catch (error) {
        console.error('Error sending chunks', error);
      }
    }
  }
);

export const notifyRiderOnRideAccepted = onDocumentUpdated(
  { document: "rides/{rideId}", region: "europe-west1" },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!before || !after) return;
    
    // Check if status changed from searching to matched/driver_arriving
    if (before.status === 'searching' && (after.status === 'matched' || after.status === 'driver_arriving')) {
      const riderId = after.rider_id || after.riderId;
      if (!riderId) return;
      
      const db = getAdminDb();
      const riderDoc = await db.collection('rider_profiles').where('user_id', '==', riderId).get();
      if (riderDoc.empty) return;
      
      const rider = riderDoc.docs[0].data();
      if (rider.push_token && Expo.isExpoPushToken(rider.push_token)) {
        try {
          const driverObj = after.driver;
          let bodyText = 'A driver has accepted your request and is on the way.';
          if (driverObj) {
            const name = driverObj.name || 'Your driver';
            const car = driverObj.vehicle_make && driverObj.vehicle_model 
              ? `${driverObj.vehicle_make} ${driverObj.vehicle_model}`
              : 'their vehicle';
            const plate = driverObj.plate ? ` (${driverObj.plate})` : '';
            bodyText = `${name} is arriving in a ${car}${plate}.`;
          }

          await expo.sendPushNotificationsAsync([{
            to: rider.push_token,
            sound: 'default',
            title: '✅ Driver Assigned!',
            body: bodyText,
            data: { rideId: event.params.rideId, type: 'ride_accepted' },
          }]);
        } catch (err) {
          console.error('Error sending push to rider', err);
        }
      }
    }
  }
);
