import { describe, expect, it } from 'vitest';
import { renderTripReceiptEmail } from './email';

const completedTrip = {
  riderEmail: 'rider@example.com',
  riderName: 'Yaw Gad',
  driverName: 'Ama Mensah',
  driverVehicle: 'White HY3N Comfort',
  driverPlate: 'GW 1234-26',
  pickup: 'Okpelen We Street 1, Ashaley Botwe',
  destination: '70 Beach Drive, Accra',
  fare: 39,
  paymentMethod: 'cash',
  distance: 6.7,
  duration: 25,
  category: 'comfort',
  tripId: 'ride_1234567890abcdef',
  completedAt: '2026-10-02T14:20:00.000Z',
};

describe('renderTripReceiptEmail', () => {
  it('renders a branded completed-trip receipt with the Driver, route, payment, and support actions', () => {
    const receipt = renderTripReceiptEmail(completedTrip);

    expect(receipt.subject).toBe('Your HY3N receipt — GH₵39.00');
    expect(receipt.html).toContain('Medaase for riding, Yaw Gad.');
    expect(receipt.html).toContain('Completed by');
    expect(receipt.html).toContain('Ama Mensah');
    expect(receipt.html).toContain('Okpelen We Street 1, Ashaley Botwe');
    expect(receipt.html).toContain('70 Beach Drive, Accra');
    expect(receipt.html).toContain('Payment method');
    expect(receipt.html).toContain('Cash');
    expect(receipt.html).toContain('Contact support');
    expect(receipt.html).toContain('Report a lost item');
    expect(receipt.text).toContain('Completed by: Ama Mensah');
    expect(receipt.text).toContain('Lost item report: mailto:hello@ridehy3n.com');
  });

  it('escapes Rider-controlled display fields and does not turn missing metrics into false details', () => {
    const receipt = renderTripReceiptEmail({
      ...completedTrip,
      riderName: '<script>bad</script>',
      driverName: 'A & B',
      distance: 0,
      duration: Number.NaN,
    });

    expect(receipt.html).toContain('&lt;script&gt;bad&lt;/script&gt;');
    expect(receipt.html).not.toContain('<script>bad</script>');
    expect(receipt.html).toContain('A &amp; B');
    expect(receipt.html).not.toContain('Distance</td>');
    expect(receipt.html).not.toContain('Duration</td>');
  });

  it('uses the embedded HY3N logo only when the delivery has an attachment', () => {
    expect(renderTripReceiptEmail(completedTrip, true).html).toContain('cid:hy3n-receipt-logo@ridehy3n.com');
    const fallback = renderTripReceiptEmail(completedTrip, false).html;
    expect(fallback).toContain('HY<span style="color:#D4AF37">3</span>N');
    expect(fallback).not.toContain('cid:hy3n-receipt-logo@ridehy3n.com');
  });

  it('uses a dark single-column receipt hero and a separate truthful fare breakdown on mobile', () => {
    const longName = 'Akwasi Mensah Osei Tutu Prempeh';
    const receipt = renderTripReceiptEmail({ ...completedTrip, riderName: longName }, true);

    expect(receipt.html).toContain(`Medaase for riding, ${longName}.`);
    expect(receipt.html).toContain('receipt-hero');
    expect(receipt.html).toContain('fare-breakdown');
    expect(receipt.html.indexOf('receipt-hero')).toBeLessThan(receipt.html.indexOf('fare-breakdown'));
    expect(receipt.html).toContain('>Total</td>');
    expect(receipt.html).toContain('Trip fare');
    expect(receipt.html).toContain('GH₵39.00');
    expect(receipt.html).not.toContain('Total paid');
  });
});
