import admin from 'firebase-admin';

// Initialize with the credentials from the backend
const serviceAccount = require('/Users/prophetgad/Documents/Projects/hy3n-backend/serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function run() {
  const doc = await db.collection('settings').doc('platform_fee').get();
  console.log("platform_fee data:", doc.data());
}

run();
