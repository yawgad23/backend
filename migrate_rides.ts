import { adminFirestore } from './src/firebaseAdmin.js';
async function run() {
  const rides = await adminFirestore.list('rides');
  const requested = rides.filter(r => r.status === 'requested');
  console.log(`Found ${requested.length} old requested rides. Cancelling them...`);
  for (const r of requested) {
    await adminFirestore.update('rides', r.id, {
      status: 'cancelled',
      cancellation_reason: 'System update: migrated old stuck requested rides to cancelled'
    });
  }
  console.log('Done.');
}
run();
