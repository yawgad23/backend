import "dotenv/config";
import { createApp } from "./app";

// Safety net: libraries like google-gax/google-auth-library sometimes schedule
// retry/token-refresh work on a detached tick, disconnected from the promise
// chain the original caller awaited — if that later rejects, Node treats it as
// fatal and kills the whole process by default. One bad Firestore credential
// lookup would otherwise take down every in-flight request, not just its own.
process.on("unhandledRejection", (reason) => {
  console.error("[fatal-guard] Unhandled rejection (server staying up):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[fatal-guard] Uncaught exception (server staying up):", err);
});

const app = createApp();
const port = parseInt(process.env.PORT || "3000", 10);
app.listen(port, () => {
  console.log(`[api] server listening on port ${port}`);
});
