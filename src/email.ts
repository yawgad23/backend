/**
 * HY3N Email Service
 *
 * Sends transactional emails via SMTP (nodemailer).
 * Configure SMTP credentials via environment variables:
 *   EMAIL_HOST     — SMTP host (e.g. smtp.gmail.com)
 *   EMAIL_PORT     — SMTP port (e.g. 587)
 *   EMAIL_USER     — SMTP username / Gmail address
 *   EMAIL_PASS     — SMTP password / Gmail App Password (no default — must be set)
 *   EMAIL_FROM     — Sender display name + address (e.g. "HY3N <noreply@ridehy3n.com>")
 */
import nodemailer from 'nodemailer';

function getTransporter() {
  const host = process.env.EMAIL_HOST || 'smtp.gmail.com';
  const port = parseInt(process.env.EMAIL_PORT || '465', 10);
  const user = process.env.EMAIL_USER || '';
  const pass = process.env.EMAIL_PASS || '';

  if (!user || !pass) {
    console.warn('[HY3N Email] EMAIL_USER/EMAIL_PASS not configured — sendTripReceiptEmail will fail');
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

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

export async function sendTripReceiptEmail(data: TripReceiptData): Promise<boolean> {
  const from = process.env.EMAIL_FROM || '"HY3N Transport" <hy3ntransportservices@gmail.com>';
  const transporter = getTransporter();

  const fareStr = `GH₵ ${data.fare.toFixed(2)}`;
  const dateStr = new Date(data.completedAt).toLocaleString('en-GH', {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });

  const metaRows = [
    data.distance ? `<tr><td style="color:#6B7280;padding:6px 0">Distance</td><td style="text-align:right;font-weight:600;padding:6px 0">${data.distance.toFixed(1)} km</td></tr>` : '',
    data.duration ? `<tr><td style="color:#6B7280;padding:6px 0">Duration</td><td style="text-align:right;font-weight:600;padding:6px 0">${data.duration} min</td></tr>` : '',
    data.category ? `<tr><td style="color:#6B7280;padding:6px 0">Category</td><td style="text-align:right;font-weight:600;padding:6px 0">${data.category}</td></tr>` : '',
  ].filter(Boolean).join('');

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:32px 0">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;max-width:560px;width:100%">
        <!-- Header -->
        <tr><td style="background:#0A0A0A;padding:28px 32px;text-align:center">
          <div style="font-size:28px;font-weight:900;color:#D4AF37;letter-spacing:2px">HY3N</div>
          <div style="color:#9CA3AF;font-size:13px;margin-top:4px">Your trip receipt</div>
        </td></tr>

        <!-- Greeting -->
        <tr><td style="padding:28px 32px 0">
          <p style="margin:0;font-size:16px;color:#111827">Hi <strong>${data.riderName}</strong>,</p>
          <p style="margin:8px 0 0;font-size:14px;color:#6B7280">Thanks for riding with HY3N. Here is your trip receipt.</p>
        </td></tr>

        <!-- Fare highlight -->
        <tr><td style="padding:20px 32px">
          <div style="background:#0A0A0A;border-radius:10px;padding:20px;text-align:center">
            <div style="color:#9CA3AF;font-size:12px;text-transform:uppercase;letter-spacing:1px">Total Fare</div>
            <div style="color:#D4AF37;font-size:36px;font-weight:900;margin-top:6px">${fareStr}</div>
            <div style="color:#9CA3AF;font-size:13px;margin-top:4px">${data.paymentMethod ? data.paymentMethod.charAt(0).toUpperCase() + data.paymentMethod.slice(1) : 'Cash'}</div>
          </div>
        </td></tr>

        <!-- Route -->
        <tr><td style="padding:0 32px">
          <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E5E7EB;border-radius:10px;overflow:hidden">
            <tr><td style="padding:14px 16px;border-bottom:1px solid #E5E7EB">
              <div style="display:flex;align-items:flex-start;gap:10px">
                <span style="display:inline-block;width:10px;height:10px;background:#22C55E;border-radius:50%;margin-top:4px;flex-shrink:0"></span>
                <div>
                  <div style="font-size:11px;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.5px">Pickup</div>
                  <div style="font-size:14px;color:#111827;font-weight:600;margin-top:2px">${data.pickup}</div>
                </div>
              </div>
            </td></tr>
            <tr><td style="padding:14px 16px">
              <div style="display:flex;align-items:flex-start;gap:10px">
                <span style="display:inline-block;width:10px;height:10px;background:#EF4444;border-radius:50%;margin-top:4px;flex-shrink:0"></span>
                <div>
                  <div style="font-size:11px;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.5px">Destination</div>
                  <div style="font-size:14px;color:#111827;font-weight:600;margin-top:2px">${data.destination}</div>
                </div>
              </div>
            </td></tr>
          </table>
        </td></tr>

        <!-- Trip details -->
        <tr><td style="padding:20px 32px">
          <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #E5E7EB">
            <tr><td style="padding-top:16px;font-size:12px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:0.8px" colspan="2">Trip Details</td></tr>
            <tr><td style="color:#6B7280;padding:6px 0">Date</td><td style="text-align:right;font-weight:600;padding:6px 0">${dateStr}</td></tr>
            <tr><td style="color:#6B7280;padding:6px 0">Driver</td><td style="text-align:right;font-weight:600;padding:6px 0">${data.driverName}</td></tr>
            <tr><td style="color:#6B7280;padding:6px 0">Vehicle</td><td style="text-align:right;font-weight:600;padding:6px 0">${data.driverVehicle}${data.driverPlate ? ` · ${data.driverPlate}` : ''}</td></tr>
            ${metaRows}
            <tr><td style="color:#6B7280;padding:6px 0">Trip ID</td><td style="text-align:right;font-family:monospace;font-size:12px;padding:6px 0">${data.tripId.slice(0, 16)}</td></tr>
          </table>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#F9FAFB;padding:20px 32px;text-align:center;border-top:1px solid #E5E7EB">
          <p style="margin:0;font-size:12px;color:#9CA3AF">Questions? Contact us at <a href="mailto:hello@ridehy3n.com" style="color:#D4AF37">hello@ridehy3n.com</a></p>
          <p style="margin:8px 0 0;font-size:11px;color:#D1D5DB">&copy; ${new Date().getFullYear()} HY3N Technologies. All rights reserved.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    'HY3N Trip Receipt',
    '─────────────────',
    `Rider: ${data.riderName}`,
    `Date: ${dateStr}`,
    `From: ${data.pickup}`,
    `To: ${data.destination}`,
    data.distance ? `Distance: ${data.distance.toFixed(1)} km` : null,
    data.duration ? `Duration: ${data.duration} min` : null,
    data.category ? `Category: ${data.category}` : null,
    `Driver: ${data.driverName}`,
    `Vehicle: ${data.driverVehicle}${data.driverPlate ? ` · ${data.driverPlate}` : ''}`,
    `Payment: ${data.paymentMethod || 'Cash'}`,
    `Fare: ${fareStr}`,
    `Trip ID: ${data.tripId.slice(0, 16)}`,
    '─────────────────',
    'Questions? hello@ridehy3n.com',
  ].filter(Boolean).join('\n');

  try {
    await transporter.sendMail({
      from,
      to: data.riderEmail,
      subject: `Your HY3N trip receipt — ${fareStr}`,
      text,
      html,
    });
    return true;
  } catch (err) {
    console.error('[HY3N Email] Failed to send receipt:', err);
    return false;
  }
}

export async function sendVerificationEmail(email: string, link: string): Promise<boolean> {
  const from = process.env.EMAIL_FROM || '"HY3N Support" <hy3ntransportservices@gmail.com>';
  const transporter = getTransporter();

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:32px 0">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;max-width:560px;width:100%">
        <!-- Header -->
        <tr><td style="background:#0A0A0A;padding:28px 32px;text-align:center">
          <div style="font-size:28px;font-weight:900;color:#D4AF37;letter-spacing:2px">HY3N</div>
          <div style="color:#9CA3AF;font-size:13px;margin-top:4px">Verify Your Email Address</div>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:28px 32px 28px">
          <p style="margin:0;font-size:16px;color:#111827">Akwaaba!</p>
          <p style="margin:12px 0 0;font-size:14px;color:#6B7280;line-height:20px">
            Thanks for signing up to drive with HY3N. Please verify your email address to continue your application.
          </p>
          <div style="margin:24px 0;text-align:center">
            <a href="${link}" style="display:inline-block;background:#D4AF37;color:#000000;text-decoration:none;padding:12px 32px;font-weight:700;font-size:15px;border-radius:8px">Verify Email Address</a>
          </div>
          <p style="margin:12px 0 0;font-size:12px;color:#9CA3AF;line-height:18px">
            If you did not request this, you can safely ignore this email.
          </p>
          <p style="margin:16px 0 0;font-size:11px;color:#D1D5DB;word-break:break-all">
            Link: <a href="${link}" style="color:#D4AF37">${link}</a>
          </p>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#F9FAFB;padding:20px 32px;text-align:center;border-top:1px solid #E5E7EB">
          <p style="margin:0;font-size:12px;color:#9CA3AF">Questions? Contact us at <a href="mailto:hello@ridehy3n.com" style="color:#D4AF37">hello@ridehy3n.com</a></p>
          <p style="margin:8px 0 0;font-size:11px;color:#D1D5DB">&copy; ${new Date().getFullYear()} HY3N Technologies. All rights reserved.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = `Verify Your Email Address\n\nPlease use the following link to verify your email address:\n\n${link}\n\nQuestions? Contact us at hello@ridehy3n.com`;

  try {
    await transporter.sendMail({
      from,
      to: email,
      subject: "Verify your email address for HY3N",
      text,
      html,
    });
    return true;
  } catch (err) {
    console.error('[HY3N Email] Failed to send verification email:', err);
    return false;
  }
}
