export interface TripReceiptData {
    riderEmail: string;
    riderName: string;
    driverName: string;
    driverVehicle: string;
    driverPlate: string;
    pickup: string;
    destination: string;
    fare: number;
    paymentMethod: string;
    distance?: number;
    duration?: number;
    category?: string;
    tripId: string;
    completedAt: string;
}
export declare function sendTripReceiptEmail(data: TripReceiptData): Promise<boolean>;
