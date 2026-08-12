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
    let query = driversRef.where('is_online', '==', true);
    
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
    const seenTokens = new Set<string>();
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
      const dLat = driver.current_lat || driver.lat;
      const dLng = driver.current_lng || driver.lng;
      if (rideLat && rideLng && dLat && dLng) {
        const distance = getDistanceFromLatLonInKm(rideLat, rideLng, dLat, dLng);
        if (distance > maxRadiusKm) {
          continue; // Skip this driver, they are too far
        }
      }
      
      if (driver.push_token && Expo.isExpoPushToken(driver.push_token) && !seenTokens.has(driver.push_token)) {
        seenTokens.add(driver.push_token);
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

export const notifyOnRideCancelled = onDocumentUpdated(
  { document: "rides/{rideId}", region: "europe-west1" },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!before || !after) return;
    
    // Check if status changed to cancelled
    if (before.status !== 'cancelled' && after.status === 'cancelled') {
      const db = getAdminDb();
      const cancelledBy = after.cancelled_by || 'unknown'; // 'rider' or 'driver'
      
      // If driver cancelled, notify rider
      if (cancelledBy === 'driver') {
        const riderId = after.rider_id || after.riderId;
        if (!riderId) return;
        
        const riderDoc = await db.collection('rider_profiles').where('user_id', '==', riderId).get();
        if (!riderDoc.empty) {
          const rider = riderDoc.docs[0].data();
          if (rider.push_token && Expo.isExpoPushToken(rider.push_token)) {
            try {
              await expo.sendPushNotificationsAsync([{
                to: rider.push_token,
                sound: 'default',
                title: '❌ Ride Cancelled',
                body: 'Your driver has cancelled the ride.',
                data: { rideId: event.params.rideId, type: 'ride_cancelled' },
              }]);
            } catch (err) {
              console.error('Error sending push to rider on cancel', err);
            }
          }
        }
      }
      
      // If rider cancelled, notify driver (if driver was already assigned)
      if (cancelledBy === 'rider') {
        const driverId = after.driver_id || after.driverId;
        if (!driverId) return; 
        
        const driverDoc = await db.collection('driver_profiles').where('user_id', '==', driverId).get();
        if (!driverDoc.empty) {
          const driver = driverDoc.docs[0].data();
          if (driver.push_token && Expo.isExpoPushToken(driver.push_token)) {
            try {
              await expo.sendPushNotificationsAsync([{
                to: driver.push_token,
                sound: 'default',
                title: '❌ Ride Cancelled',
                body: 'The rider has cancelled the ride.',
                data: { rideId: event.params.rideId, type: 'ride_cancelled' },
              }]);
            } catch (err) {
              console.error('Error sending push to driver on cancel', err);
            }
          }
        }
      }
    }
  }
);

export const notifyDriverOnApprovalStatusChange = onDocumentUpdated(
  { document: "driver_profiles/{driverId}", region: "europe-west1" },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!before || !after) return;
    
    // Check if approval_status changed
    if (before.approval_status !== after.approval_status) {
      if (!after.push_token || !Expo.isExpoPushToken(after.push_token)) return;
      
      let title = '';
      let body = '';
      
      if (after.approval_status === 'approved') {
        title = '🎉 Account Approved!';
        body = 'Congratulations! Your driver account has been approved. You can now go online and accept rides.';
      } else if (after.approval_status === 'rejected') {
        title = '❌ Account Update';
        body = 'Your driver account registration was rejected. Please open the app for details or to contact support.';
      } else {
        return; // Don't send on 'pending' or other statuses
      }

      try {
        await expo.sendPushNotificationsAsync([{
          to: after.push_token,
          sound: 'default',
          title,
          body,
          data: { driverId: event.params.driverId, type: 'approval_status_update' },
        }]);
      } catch (err) {
        console.error('Error sending push to driver for approval update', err);
      }
    }
  }
);

export const notifyOnNewChatMessage = onDocumentCreated(
  { document: "ride_messages/{messageId}", region: "europe-west1" },
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;
    
    const message = snapshot.data();
    if (!message.ride_id || !message.sender_id || !message.message) return;
    
    const db = getAdminDb();
    
    // Fetch the ride to figure out who the other person is
    const rideDoc = await db.collection('rides').doc(message.ride_id).get();
    if (!rideDoc.exists) return;
    
    const ride = rideDoc.data();
    if (!ride) return;
    
    const riderId = ride.rider_id || ride.riderId;
    const driverId = ride.driver_id || ride.driverId;
    
    if (!riderId || !driverId) return; // Need both parties to send a message
    
    let targetPushToken = null;
    let title = 'New Message';
    
    // If sender is the rider, notify the driver
    if (message.sender_id === riderId) {
      const driverQuery = await db.collection('driver_profiles').where('user_id', '==', driverId).get();
      if (!driverQuery.empty) {
        targetPushToken = driverQuery.docs[0].data().push_token;
        const riderQuery = await db.collection('rider_profiles').where('user_id', '==', riderId).get();
        if (!riderQuery.empty) {
          const riderName = riderQuery.docs[0].data().name || 'Rider';
          title = `Message from ${riderName}`;
        }
      }
    } 
    // If sender is the driver, notify the rider
    else if (message.sender_id === driverId) {
      const riderQuery = await db.collection('rider_profiles').where('user_id', '==', riderId).get();
      if (!riderQuery.empty) {
        targetPushToken = riderQuery.docs[0].data().push_token;
        const driverQuery = await db.collection('driver_profiles').where('user_id', '==', driverId).get();
        if (!driverQuery.empty) {
          const driverName = driverQuery.docs[0].data().name || 'Driver';
          title = `Message from ${driverName}`;
        }
      }
    }
    
    if (targetPushToken && Expo.isExpoPushToken(targetPushToken)) {
      try {
        const expo = new Expo();
        await expo.sendPushNotificationsAsync([{
          to: targetPushToken,
          sound: 'default',
          title: title,
          body: message.message,
          data: { type: 'chat_message', rideId: message.ride_id },
        }]);
      } catch (err) {
        console.error('Error sending push notification for chat message', err);
      }
    }
  }
);
