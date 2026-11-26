import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const smtp = vi.hoisted(() => ({ createTransport: vi.fn(), sendMail: vi.fn(), close: vi.fn() }));
vi.mock('nodemailer', () => ({ default: { createTransport: smtp.createTransport } }));
import { sendSupportEmail, supportEmailConfiguration, supportEmailPayload, SupportEmailError } from './supportEmail';

const input = {
  to: 'rider@example.com', subject: 'A support ticket', message: 'We are checking your trip.', replyId: 'a'.repeat(64),
};
const environment = [
  'SUPPORT_EMAIL_USER', 'SUPPORT_EMAIL_PASS', 'SUPPORT_EMAIL_HOST', 'SUPPORT_EMAIL_PORT',
  'EMAIL_USER', 'EMAIL_PASS', 'EMAIL_HOST', 'EMAIL_PORT',
];

beforeEach(() => {
  vi.resetAllMocks();
  for (const name of environment) vi.stubEnv(name, '');
  vi.stubEnv('SUPPORT_EMAIL_USER', 'hello@ridehy3n.com');
  vi.stubEnv('SUPPORT_EMAIL_PASS', 'offline-test-password');
  vi.stubEnv('SUPPORT_EMAIL_HOST', 'smtp.offline.example');
  smtp.createTransport.mockReturnValue({ sendMail: smtp.sendMail, close: smtp.close });
  smtp.sendMail.mockResolvedValue({ accepted: [input.to], messageId: 'provider-id' });
});
afterEach(() => vi.unstubAllEnvs());

describe('support mailbox configuration', () => {
  it('uses the fixed HY3N mailbox and secure default SMTP port', () => {
    expect(supportEmailConfiguration()).toMatchObject({ configured: true, sender: 'HY3N <hello@ridehy3n.com>',
      replyTo: 'hello@ridehy3n.com', host: 'smtp.offline.example', port: 465 });
  });

  it.each([
    ['different account', 'SUPPORT_EMAIL_USER', 'personal@example.com'],
    ['missing password', 'SUPPORT_EMAIL_PASS', ''],
    ['missing explicit host', 'SUPPORT_EMAIL_HOST', ''],
    ['unsupported port', 'SUPPORT_EMAIL_PORT', '25'],
    ['non-numeric port', 'SUPPORT_EMAIL_PORT', 'invalid'],
  ])('fails closed for %s without constructing a transport', async (_label, key, value) => {
    vi.stubEnv(key, value);
    expect(supportEmailConfiguration().configured).toBe(false);
    await expect(sendSupportEmail(input)).rejects.toMatchObject({ delivery: 'failed' });
    expect(smtp.createTransport).not.toHaveBeenCalled();
    expect(smtp.sendMail).not.toHaveBeenCalled();
  });

  it('supports legacy configuration only when its account is the actual support mailbox', () => {
    vi.stubEnv('SUPPORT_EMAIL_USER', ''); vi.stubEnv('SUPPORT_EMAIL_PASS', '');
    vi.stubEnv('EMAIL_USER', 'HELLO@RIDEHY3N.COM'); vi.stubEnv('EMAIL_PASS', 'offline-legacy-password');
    vi.stubEnv('EMAIL_PORT', '587');
    expect(supportEmailConfiguration()).toMatchObject({ configured: true, port: 587 });
    vi.stubEnv('EMAIL_USER', 'other@example.com');
    expect(supportEmailConfiguration().configured).toBe(false);
  });
});

describe('safe, branded support email payload', () => {
  it('escapes administrator text in HTML while retaining verbatim plain text and line breaks', () => {
    const message = '<script>alert("x")</script> & \'quoted\'\nNext line';
    const payload = supportEmailPayload({ ...input, message });
    expect(payload).toMatchObject({ from: 'HY3N <hello@ridehy3n.com>', to: input.to,
      replyTo: 'hello@ridehy3n.com', subject: 'Re: A support ticket' });
    expect(payload.html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quoted&#39;\nNext line');
    expect(payload.html).not.toContain('<script>');
    expect(payload.html).toContain('white-space:pre-wrap');
    expect(payload.html).toContain('HY3N Support');
    expect(payload.html).toContain('mailto:hello@ridehy3n.com');
    expect(payload.text).toBe(`${message}\n\nHY3N Support\nhello@ridehy3n.com\nhttps://ridehy3n.com`);
  });

  it('removes header control characters and bounds the subject, including a safe fallback', () => {
    const payload = supportEmailPayload({ ...input, subject: 'Hello\r\nBcc: attacker@example.com\u0000\u0001\t' + 'x'.repeat(200) });
    expect(payload.subject).not.toMatch(/[\u0000-\u001f]/);
    expect(payload.subject).toHaveLength(164); // "Re: " plus the bounded ticket subject.
    expect(supportEmailPayload({ ...input, subject: '\r\n\u0000 ' }).subject).toBe('Re: Your message to HY3N');
    expect(payload).not.toHaveProperty('bcc');
    expect(payload).not.toHaveProperty('cc');
  });

  it('uses a stable deterministic Message-ID for the same persisted reply', () => {
    expect(supportEmailPayload(input).messageId).toBe(`<support-${input.replyId}@ridehy3n.com>`);
    expect(supportEmailPayload({ ...input, message: 'Different render' }).messageId).toBe(supportEmailPayload(input).messageId);
    expect(supportEmailPayload({ ...input, replyId: 'b'.repeat(64) }).messageId).not.toBe(supportEmailPayload(input).messageId);
  });

  it.each(['bad-address', 'rider@example.com\r\nBcc: attacker@example.com', 'a'.repeat(255) + '@example.com'])
    ('rejects an invalid recipient before creating SMTP transport: %s', async (to) => {
      await expect(sendSupportEmail({ ...input, to })).rejects.toThrow();
      expect(smtp.createTransport).not.toHaveBeenCalled();
      expect(smtp.sendMail).not.toHaveBeenCalled();
    });
});

describe('offline SMTP acceptance and uncertainty', () => {
  it.each([465, 587])('sends only through the stubbed transport on configured port %s and closes it', async (port) => {
    vi.stubEnv('SUPPORT_EMAIL_PORT', String(port));
    await expect(sendSupportEmail(input)).resolves.toEqual({ messageId: 'provider-id' });
    expect(smtp.createTransport).toHaveBeenCalledWith({ host: 'smtp.offline.example', port, secure: port === 465,
      requireTLS: port === 587,
      auth: { user: 'hello@ridehy3n.com', pass: 'offline-test-password' },
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000 });
    expect(smtp.sendMail).toHaveBeenCalledTimes(1);
    expect(smtp.sendMail).toHaveBeenCalledWith(supportEmailPayload(input));
    expect(smtp.close).toHaveBeenCalledTimes(1);
  });

  it('requires recipient-specific acceptance, case insensitively, and uses stable fallback Message-ID', async () => {
    smtp.sendMail.mockResolvedValue({ accepted: [input.to.toUpperCase()] });
    await expect(sendSupportEmail(input)).resolves.toEqual({ messageId: supportEmailPayload(input).messageId });
    expect(smtp.close).toHaveBeenCalledTimes(1);
  });

  it('accepts an intended recipient represented as an address object', async () => {
    smtp.sendMail.mockResolvedValue({ accepted: [{ address: input.to, name: 'Fixture' }] });
    await expect(sendSupportEmail(input)).resolves.toEqual({ messageId: supportEmailPayload(input).messageId });
  });

  it('bounds an untrusted provider Message-ID', async () => {
    smtp.sendMail.mockResolvedValue({ accepted: [input.to], messageId: 'm'.repeat(500) });
    expect((await sendSupportEmail(input)).messageId).toHaveLength(300);
  });

  it('reports definite failure only when the intended recipient was explicitly rejected', async () => {
    smtp.sendMail.mockResolvedValue({ accepted: [], rejected: [input.to] });
    await expect(sendSupportEmail(input)).rejects.toMatchObject({ delivery: 'failed' });
    expect(smtp.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    { accepted: ['someone-else@example.com'] },
    { accepted: undefined },
    { accepted: input.to },
  ])('does not report acceptance without the intended recipient: %j', async (result) => {
    smtp.sendMail.mockResolvedValue(result);
    await expect(sendSupportEmail(input)).rejects.toMatchObject({ delivery: 'unknown' });
    expect(smtp.close).toHaveBeenCalledTimes(1);
  });

  it.each(['EAUTH', 'EENVELOPE', 'ECONNREFUSED', 'ENOTFOUND'])('classifies definite %s errors as failed', async (code) => {
    smtp.sendMail.mockRejectedValue(Object.assign(new Error('secret SMTP detail'), { code }));
    await expect(sendSupportEmail(input)).rejects.toMatchObject({ delivery: 'failed' });
    expect(smtp.close).toHaveBeenCalledTimes(1);
  });

  it.each(['ETIMEDOUT', 'ECONNRESET', 'ESOCKET', 'EMESSAGE', ''])('preserves delivery uncertainty for %s', async (code) => {
    smtp.sendMail.mockRejectedValue(Object.assign(new Error('private SMTP detail'), { code }));
    await expect(sendSupportEmail(input)).rejects.toMatchObject({ delivery: 'unknown' });
    expect(smtp.close).toHaveBeenCalledTimes(1);
  });

  it('preserves typed uncertainty errors without exposing provider diagnostics', async () => {
    const error = new SupportEmailError('unknown');
    smtp.sendMail.mockRejectedValue(error);
    await expect(sendSupportEmail(input)).rejects.toBe(error);
    expect(error.message).not.toContain('private SMTP');
    expect(smtp.close).toHaveBeenCalledTimes(1);
  });
});
