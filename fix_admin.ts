import { getAdminAuth } from './src/firebaseAdmin';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

async function main() {
  const email = 'Yawgad23@gmail.com';
  const password = 'Password123!';
  const auth = getAdminAuth();
  
  try {
    const user = await auth.getUserByEmail(email);
    console.log(`User found: ${user.uid}. Updating password to "Password123!" and setting admin claims...`);
    await auth.updateUser(user.uid, { password });
    await auth.setCustomUserClaims(user.uid, { admin: true });
    console.log('Successfully updated user.');
  } catch (err: any) {
    if (err.code === 'auth/user-not-found') {
      console.log(`User not found. Creating user with email "${email}" and password "Password123!"...`);
      const user = await auth.createUser({
        email,
        password,
        emailVerified: true,
      });
      await auth.setCustomUserClaims(user.uid, { admin: true });
      console.log(`Successfully created user: ${user.uid}`);
    } else {
      console.error('Error:', err);
    }
  }
}

main().catch(console.error);
