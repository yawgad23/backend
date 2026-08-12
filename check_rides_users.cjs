const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

async function check() {
  const ridesSnap = await db.collection("rides").get();
  console.log(`Found ${ridesSnap.docs.length} rides in total.`);
  
  const ridesByRider = {};
  ridesSnap.forEach(doc => {
    const data = doc.data();
    if (!ridesByRider[data.rider_id]) ridesByRider[data.rider_id] = 0;
    ridesByRider[data.rider_id]++;
  });
  
  console.log("Rides count by rider_id:", ridesByRider);
  
  // List all auth users
  const listUsersResult = await admin.auth().listUsers(100);
  console.log(`\nFound ${listUsersResult.users.length} users in Firebase Auth:`);
  listUsersResult.users.forEach(userRecord => {
    console.log(`- UID: ${userRecord.uid}, Phone: ${userRecord.phoneNumber || 'N/A'}, Email: ${userRecord.email || 'N/A'}`);
  });
}

check().catch(console.error);
