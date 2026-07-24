export declare const notifyDriversOnRideCreated: import("firebase-functions/core").CloudFunction<import("firebase-functions/v2/firestore").FirestoreEvent<import("firebase-functions/v2/firestore").QueryDocumentSnapshot | undefined, {
    rideId: string;
}>>;
export declare const notifyRiderOnRideAccepted: import("firebase-functions/core").CloudFunction<import("firebase-functions/v2/firestore").FirestoreEvent<import("firebase-functions/core").Change<import("firebase-functions/v2/firestore").QueryDocumentSnapshot> | undefined, {
    rideId: string;
}>>;
