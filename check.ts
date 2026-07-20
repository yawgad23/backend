import { getAdminDb } from './src/firebaseAdmin';

async function check() {
  const db = getAdminDb();
  const snap = await db.collection('rides').get();
  console.log(`Found ${snap.size} rides.`);
  snap.forEach(doc => {
    console.log(`${doc.id} => ${doc.data().status}`);
  });
}

check().catch(console.error);
