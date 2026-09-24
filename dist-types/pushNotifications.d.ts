export type PushRole = 'rider' | 'driver';
export declare function isExpoPushToken(token: string): boolean;
/**
 * Stores one app-install token under a server-only collection. A token is not
 * client-readable, so another account cannot use it to infer a recipient's
 * device information or send their own notifications.
 */
export declare function registerPushDevice(input: {
    uid: string;
    role: PushRole;
    token: string;
    platform: 'ios' | 'android';
    appVersion?: string;
}): Promise<{
    id: string;
}>;
/**
 * Sends a private ride-chat notification only after a newly created message is
 * verified against the parent ride. The Firestore trigger, rather than either
 * mobile client, owns dispatch so pushes also work when a sender is offline.
 */
export declare function sendRideChatPush(messageId: string, rawMessage: Record<string, any>): Promise<{
    attempted: number;
    sent: number;
}>;
