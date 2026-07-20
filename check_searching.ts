import { getAdminDb } from './src/firebaseAdmin';

async function check() {
  const db = getAdminDb();
  const snap = await db.collection('rides').where('status', '==', 'searching').get();
  console.log(`Found ${snap.size} searching rides.`);
  snap.forEach(doc => {
    console.log(`${doc.id} => ${doc.data().status}`);
  });
}

check().catch(console.error);
