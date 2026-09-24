export declare const api: import("firebase-functions/v2/https").HttpsFunction;
/**
 * The Rider and Driver clients write chat messages directly to Firestore for
 * real-time conversation. This event handler mirrors each new message to the
 * authenticated recipient's registered Expo device(s), including when their
 * app is backgrounded or not currently running.
 */
export declare const chatMessagePush: import("firebase-functions/core").CloudFunction<import("firebase-functions/v2/firestore").FirestoreEvent<import("firebase-functions/v2/firestore").QueryDocumentSnapshot | undefined, {
    messageId: string;
}>>;
