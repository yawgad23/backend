const admin = require("firebase-admin");
admin.initializeApp({
  projectId: "hy3n26",
});
const db = admin.firestore();

async function main() {
  const snapshot = await db.collection("rides").orderBy("created_at", "desc").limit(1).get();
  if (snapshot.empty) {
    console.log("No rides found.");
    return;
  }
  snapshot.forEach(doc => {
    console.log("Latest Ride ID:", doc.id);
    console.log("Data:", JSON.stringify(doc.data(), null, 2));
  });
}
main().catch(console.error);
