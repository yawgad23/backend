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
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const RECEIPT_LOGO_CID = 'hy3n-receipt-logo@ridehy3n.com';

export function getReceiptLogoAttachment() {
  const assetDirectory = path.join(process.cwd(), 'assets');
  const logoFile = ['hy3n-receipt-logo-supplied.png', 'hy3n-receipt-wordmark.png', 'hy3n-receipt-logo.png']
    .find((filename) => existsSync(path.join(assetDirectory, filename)));
  if (!logoFile) {
    console.warn('[HY3N Email] Receipt logo asset not found:', assetDirectory);
    return null;
  }
  return {
    filename: logoFile,
    content: readFileSync(path.join(assetDirectory, logoFile)),
    cid: RECEIPT_LOGO_CID,
  };
}

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

function escapeHtml(value: unknown) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[character] || character));
}

function receiptValue(value: unknown, fallback: string) {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function formattedPaymentMethod(value: unknown) {
  const method = receiptValue(value, 'Cash').replace(/[_-]+/g, ' ');
  return method.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function validMetric(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function renderTripReceiptEmail(data: TripReceiptData, hasEmbeddedLogo = false) {
  const riderName = receiptValue(data.riderName, 'HY3N Rider');
  const driverName = receiptValue(data.driverName, 'Your HY3N driver');
  const driverVehicle = receiptValue(data.driverVehicle, 'HY3N vehicle');
  const driverPlate = String(data.driverPlate || '').trim();
  const pickup = receiptValue(data.pickup, 'Pickup location');
  const destination = receiptValue(data.destination, 'Destination');
  const category = String(data.category || '').trim();
  const paymentMethod = formattedPaymentMethod(data.paymentMethod);
  const tripId = receiptValue(data.tripId, 'HY3N trip').slice(0, 16);
  const fare = Number.isFinite(Number(data.fare)) ? Math.max(0, Number(data.fare)) : 0;
  const fareStr = `GH₵${fare.toFixed(2)}`;
  const date = new Date(data.completedAt);
  const dateStr = Number.isNaN(date.getTime())
    ? 'Trip completed'
    : date.toLocaleString('en-GH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Africa/Accra' });
  const receiptDate = Number.isNaN(date.getTime())
    ? 'Ride completed'
    : date.toLocaleString('en-GH', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Africa/Accra' });
  const distance = validMetric(data.distance);
  const duration = validMetric(data.duration);
  const lostItemLink = `mailto:hello@ridehy3n.com?subject=${encodeURIComponent(`Lost item report — trip ${tripId}`)}&body=${encodeURIComponent(`Hello HY3N Support,\n\nI need help with a lost item from trip ${tripId}.\n\nItem description:\n\nThank you.`)}`;
  const supportLink = `mailto:hello@ridehy3n.com?subject=${encodeURIComponent(`Trip support — ${tripId}`)}`;
  const logo = hasEmbeddedLogo
    ? `<img src="cid:${RECEIPT_LOGO_CID}" alt="HY3N — Ride With Pride" width="154" style="display:block;width:154px;max-width:154px;height:auto;border:0;outline:none;text-decoration:none" />`
    : '<div style="font-size:24px;line-height:28px;font-weight:900;letter-spacing:1px;color:#17191D">HY<span style="color:#D4AF37">3</span>N</div>';

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style type="text/css">@media screen and (max-width:480px){.receipt-shell{width:100% !important}.mobile-pad{padding-left:24px !important;padding-right:24px !important}.hero-title{font-size:32px !important;line-height:38px !important;letter-spacing:-0.5px !important}.receipt-logo{width:132px !important;max-width:132px !important}.email-outer{padding:16px 0 !important}}</style></head>
<body style="margin:0;padding:0;background:#1B1C20;font-family:Arial,Helvetica,sans-serif;color:#FFFFFF">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0">Your HY3N trip with ${escapeHtml(driverName)} is complete. Total: ${fareStr}.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="email-outer" style="background:#1B1C20;padding:24px 12px"><tr><td align="center">
    <table role="presentation" width="620" cellpadding="0" cellspacing="0" border="0" class="receipt-shell" style="width:100%;max-width:620px;background:#FFFFFF">
      <tr><td class="receipt-hero mobile-pad" style="background:#353638;padding:30px 44px 34px;color:#FFFFFF">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:0;text-align:center"><span class="receipt-logo" style="display:inline-block;width:154px;max-width:154px">${logo}</span></td></tr></table>
        <div style="font-size:15px;line-height:22px;color:#D0D1D4;padding-top:42px">${escapeHtml(receiptDate)}</div>
        <div class="hero-title" style="font-size:42px;line-height:48px;font-weight:800;letter-spacing:-1px;color:#FFFFFF;padding-top:24px">Medaase for riding, ${escapeHtml(riderName)}.</div>
        <div style="font-size:18px;line-height:28px;color:#F0F0F1;padding-top:24px">We hope you enjoyed your ride.</div>
      </td></tr>
      <tr><td class="fare-breakdown mobile-pad" style="background:#202124;padding:30px 44px 34px;color:#FFFFFF">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="padding:0 0 28px;font-size:34px;line-height:40px;font-weight:800;color:#FFFFFF">Total</td>
          <td align="right" style="padding:0 0 28px;font-size:34px;line-height:40px;font-weight:800;color:#FFFFFF;white-space:nowrap">${fareStr}</td>
        </tr></table>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #3C3E43;border-bottom:1px solid #3C3E43"><tr>
          <td style="padding:22px 0;font-size:18px;line-height:26px;color:#F1F1F2">Trip fare</td>
          <td align="right" style="padding:22px 0;font-size:18px;line-height:26px;color:#F1F1F2;white-space:nowrap">${fareStr}</td>
        </tr></table>
      </td></tr>
      <tr><td class="mobile-pad" style="padding:26px 30px 8px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #E6E8EC;border-radius:14px"><tr><td style="padding:18px 20px">
          <div style="font-size:11px;font-weight:700;letter-spacing:1.1px;color:#7B808A;text-transform:uppercase">Completed by</div>
          <div style="font-size:22px;line-height:29px;font-weight:800;color:#17191D;padding-top:4px">${escapeHtml(driverName)}</div>
          <div style="font-size:14px;line-height:21px;color:#5F6672;padding-top:5px">${escapeHtml(driverVehicle)}${driverPlate ? ` <span style="color:#A3A8B1">•</span> ${escapeHtml(driverPlate)}` : ''}${category ? ` <span style="color:#A3A8B1">•</span> ${escapeHtml(category)}` : ''}</div>
        </td></tr></table>
      </td></tr>
      <tr><td class="mobile-pad" style="padding:18px 30px 8px"><div style="font-size:21px;line-height:28px;font-weight:800;color:#17191D">Trip details</div><div style="font-size:13px;color:#747B86;padding-top:4px">${escapeHtml(dateStr)}</div></td></tr>
      <tr><td class="mobile-pad" style="padding:8px 30px 18px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-left:2px solid #D6D9DF">
          <tr><td width="28" style="vertical-align:top;padding:0 0 20px 14px"><span style="display:block;width:12px;height:12px;background:#078859;border:3px solid #DDF5EC;border-radius:50%"></span></td><td style="padding:0 0 20px 0"><div style="font-size:11px;font-weight:700;letter-spacing:1px;color:#7B808A;text-transform:uppercase">Pickup</div><div style="font-size:15px;line-height:22px;font-weight:700;color:#20232A;padding-top:4px">${escapeHtml(pickup)}</div></td></tr>
          <tr><td width="28" style="vertical-align:top;padding-left:14px"><span style="display:block;width:12px;height:12px;background:#E6533C;border:3px solid #FCE9E5;border-radius:2px"></span></td><td><div style="font-size:11px;font-weight:700;letter-spacing:1px;color:#7B808A;text-transform:uppercase">Drop-off</div><div style="font-size:15px;line-height:22px;font-weight:700;color:#20232A;padding-top:4px">${escapeHtml(destination)}</div></td></tr>
        </table>
      </td></tr>
      <tr><td class="mobile-pad" style="padding:4px 30px 24px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #E6E8EC;border-bottom:1px solid #E6E8EC">
          <tr><td style="padding:16px 0;color:#606873;font-size:14px">Payment method</td><td align="right" style="padding:16px 0;color:#20232A;font-weight:700;font-size:14px">${escapeHtml(paymentMethod)}</td></tr>
          ${distance ? `<tr><td style="padding:0 0 16px;color:#606873;font-size:14px">Distance</td><td align="right" style="padding:0 0 16px;color:#20232A;font-weight:700;font-size:14px">${distance.toFixed(1)} km</td></tr>` : ''}
          ${duration ? `<tr><td style="padding:0 0 16px;color:#606873;font-size:14px">Duration</td><td align="right" style="padding:0 0 16px;color:#20232A;font-weight:700;font-size:14px">${Math.round(duration)} min</td></tr>` : ''}
          <tr><td style="padding:0 0 16px;color:#606873;font-size:14px">Trip ID</td><td align="right" style="padding:0 0 16px;color:#20232A;font-family:monospace;font-size:12px">${escapeHtml(tripId)}</td></tr>
        </table>
      </td></tr>
      <tr><td class="mobile-pad" style="padding:0 30px 26px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F7F8FA;border-radius:12px"><tr><td style="padding:18px 20px"><div style="font-size:18px;font-weight:800;color:#20232A">Need help with this trip?</div><div style="font-size:14px;line-height:21px;color:#606873;padding-top:5px">Our HY3N Support team is ready to help.</div><div style="padding-top:15px"><a href="${supportLink}" style="display:inline-block;background:#17191D;color:#FFFFFF;text-decoration:none;font-size:14px;font-weight:700;padding:12px 18px;border-radius:8px">Contact support</a></div></td></tr></table></td></tr>
      <tr><td class="mobile-pad" style="padding:0 30px 30px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #E6E8EC;border-radius:12px"><tr><td style="padding:18px 20px"><div style="font-size:18px;font-weight:800;color:#20232A">Forgot something?</div><div style="font-size:14px;line-height:21px;color:#606873;padding-top:5px">Report a lost item and include your trip details so we can help quickly.</div><div style="padding-top:15px"><a href="${lostItemLink}" style="display:inline-block;background:#FFFFFF;color:#17191D;text-decoration:none;font-size:14px;font-weight:700;padding:11px 17px;border:1px solid #BFC5CE;border-radius:8px">Report a lost item</a></div></td></tr></table></td></tr>
      <tr><td class="mobile-pad" style="background:#101114;padding:24px 30px;text-align:center"><div style="font-size:13px;line-height:20px;color:#C7CBD2">HY3N Technologies · Ghana</div><div style="font-size:12px;line-height:19px;color:#8F959F;padding-top:5px">Questions? <a href="mailto:hello@ridehy3n.com" style="color:#F4C542;text-decoration:none">hello@ridehy3n.com</a> · <a href="https://ridehy3n.com" style="color:#F4C542;text-decoration:none">ridehy3n.com</a></div><div style="font-size:11px;color:#6F7580;padding-top:10px">© ${new Date().getFullYear()} HY3N Technologies. All rights reserved.</div></td></tr>
    </table>
  </td></tr></table>
</body></html>`;

  const text = [
    'HY3N — Ride receipt',
    `Medaase for riding, ${riderName}.`,
    `Total fare: ${fareStr}`,
    `Trip fare: ${fareStr}`,
    `Completed by: ${driverName}`,
    `Vehicle: ${driverVehicle}${driverPlate ? ` · ${driverPlate}` : ''}`,
    `Pickup: ${pickup}`,
    `Drop-off: ${destination}`,
    `Payment method: ${paymentMethod}`,
    distance ? `Distance: ${distance.toFixed(1)} km` : null,
    duration ? `Duration: ${Math.round(duration)} min` : null,
    category ? `Category: ${category}` : null,
    `Trip ID: ${tripId}`,
    'Need help? hello@ridehy3n.com',
    `Lost item report: ${lostItemLink}`,
  ].filter(Boolean).join('\n');

  return {
    subject: `Your HY3N receipt — ${fareStr}`,
    html,
    text,
  };
}

export async function sendTripReceiptEmail(data: TripReceiptData): Promise<boolean> {
  const from = process.env.EMAIL_FROM || '"HY3N Transport" <hy3ntransportservices@gmail.com>';
  const transporter = getTransporter();
  const logoAttachment = getReceiptLogoAttachment();
  const receipt = renderTripReceiptEmail(data, Boolean(logoAttachment));

  try {
    await transporter.sendMail({
      from,
      to: data.riderEmail,
      subject: receipt.subject,
      text: receipt.text,
      html: receipt.html,
      attachments: logoAttachment ? [logoAttachment] : undefined,
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

/** Sends a server-generated Firebase password-reset link through HY3N SMTP. */
export async function sendPasswordResetEmail(email: string, link: string): Promise<boolean> {
  const from = process.env.EMAIL_FROM || '"HY3N Support" <hy3ntransportservices@gmail.com>';
  const transporter = getTransporter();
  const safeLink = String(link || '');
  if (!safeLink.startsWith('https://')) return false;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:32px 0"><tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;max-width:560px;width:100%">
      <tr><td style="background:#0A0A0A;padding:28px 32px;text-align:center"><div style="font-size:28px;font-weight:900;color:#D4AF37;letter-spacing:2px">HY3N</div><div style="color:#9CA3AF;font-size:13px;margin-top:4px">Password reset request</div></td></tr>
      <tr><td style="padding:28px 32px"><p style="margin:0;font-size:16px;color:#111827">Reset your password</p><p style="margin:12px 0 0;font-size:14px;color:#6B7280;line-height:20px">Use the secure button below to choose a new HY3N password. If you did not request this, you can safely ignore this email.</p><div style="margin:24px 0;text-align:center"><a href="${safeLink}" style="display:inline-block;background:#D4AF37;color:#000000;text-decoration:none;padding:12px 32px;font-weight:700;font-size:15px;border-radius:8px">Reset Password</a></div><p style="margin:12px 0 0;font-size:12px;color:#9CA3AF;line-height:18px">For your security, do not share this link with anyone.</p></td></tr>
      <tr><td style="background:#F9FAFB;padding:20px 32px;text-align:center;border-top:1px solid #E5E7EB"><p style="margin:0;font-size:12px;color:#9CA3AF">Questions? Contact <a href="mailto:hello@ridehy3n.com" style="color:#D4AF37">hello@ridehy3n.com</a></p></td></tr>
    </table>
  </td></tr></table>
</body>
</html>`;

  try {
    await transporter.sendMail({
      from,
      to: email,
      subject: 'Reset your HY3N password',
      text: `Reset your HY3N password\n\nUse this secure link to choose a new password:\n${safeLink}\n\nIf you did not request this, you can safely ignore this email.`,
      html,
    });
    return true;
  } catch (err) {
    console.error('[HY3N Email] Failed to send password reset:', err);
    return false;
  }
}
