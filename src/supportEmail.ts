import nodemailer from 'nodemailer';
import { z } from 'zod';

const SUPPORT_ADDRESS = 'hello@ridehy3n.com';
const mailbox = z.string().trim().max(254).email();
export class SupportEmailError extends Error {
  constructor(public readonly delivery: 'failed' | 'unknown') {
    super(delivery === 'failed' ? 'Support email could not be sent. Your draft is retained.' : 'Email delivery could not be confirmed. Check this reply before sending again.');
  }
}
export interface SupportEmailMessage { to: string; subject: string; message: string; replyId: string }
export function supportEmailConfiguration() {
  const user = process.env.SUPPORT_EMAIL_USER || process.env.EMAIL_USER || '';
  const pass = process.env.SUPPORT_EMAIL_PASS || process.env.EMAIL_PASS || '';
  const host = process.env.SUPPORT_EMAIL_HOST || process.env.EMAIL_HOST || '';
  const port = Number(process.env.SUPPORT_EMAIL_PORT || process.env.EMAIL_PORT || '465');
  // Do not impersonate the support mailbox through an unrelated personal account.
  const configured = user.trim().toLowerCase() === SUPPORT_ADDRESS && !!pass && !!host && [465, 587].includes(port);
  return { configured, sender: `HY3N <${SUPPORT_ADDRESS}>`, replyTo: SUPPORT_ADDRESS, user, pass, host, port };
}
function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}
export function supportEmailPayload(input: SupportEmailMessage) {
  const to = mailbox.parse(input.to);
  const subject = `Re: ${input.subject.replace(/[\r\n\u0000-\u001f]/g, ' ').trim().slice(0, 160) || 'Your message to HY3N'}`;
  const text = `${input.message}\n\nHY3N Support\n${SUPPORT_ADDRESS}\nhttps://ridehy3n.com`;
  return {
    from: `HY3N <${SUPPORT_ADDRESS}>`, to, replyTo: SUPPORT_ADDRESS, subject, text,
    html: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#111"><h2>HY3N Support</h2><div style="white-space:pre-wrap">${escapeHtml(input.message)}</div><p>HY3N Support<br><a href="mailto:${SUPPORT_ADDRESS}">${SUPPORT_ADDRESS}</a></p></div>`,
    messageId: `<support-${input.replyId}@ridehy3n.com>`,
  };
}
export async function sendSupportEmail(input: SupportEmailMessage): Promise<{ messageId: string }> {
  const configuration = supportEmailConfiguration();
  if (!configuration.configured) throw new SupportEmailError('failed');
  const payload = supportEmailPayload(input);
  const transporter = nodemailer.createTransport({
    host: configuration.host, port: configuration.port, secure: configuration.port === 465,
    requireTLS: configuration.port === 587,
    auth: { user: configuration.user, pass: configuration.pass },
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000,
  });
  try {
    const result = await transporter.sendMail(payload);
    const matchesRecipient = (value: unknown) => {
      const address = typeof value === 'string' ? value : value && typeof value === 'object' ? (value as { address?: unknown }).address : '';
      return typeof address === 'string' && address.toLowerCase() === payload.to.toLowerCase();
    };
    if (!Array.isArray(result.accepted) || !result.accepted.some(matchesRecipient)) {
      const rejected = Array.isArray(result.rejected) && result.rejected.some(matchesRecipient);
      throw new SupportEmailError(rejected ? 'failed' : 'unknown');
    }
    return { messageId: String(result.messageId || payload.messageId).slice(0, 300) };
  } catch (error: unknown) {
    if (error instanceof SupportEmailError) throw error;
    const code = typeof error === 'object' && error ? String((error as { code?: unknown }).code || '') : '';
    // An SMTP timeout can occur after acceptance: never report definite failure or auto-resend it.
    throw new SupportEmailError(['EAUTH', 'EENVELOPE', 'ECONNREFUSED', 'ENOTFOUND'].includes(code) ? 'failed' : 'unknown');
  } finally {
    transporter.close();
  }
}
