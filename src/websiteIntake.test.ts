import { describe, expect, it } from 'vitest';
import {
  allowsWebsiteIntake,
  websiteIntakeInput,
  websiteIntakeRateKey,
  websiteIntakeTicket,
} from './websiteIntake';

describe('website intake validation', () => {
  it('accepts a complete Work & Pay application and stores it as an open website ticket', () => {
    const parsed = websiteIntakeInput.parse({
      kind: 'car',
      firstName: 'Kofi',
      lastName: 'Mensah',
      phone: '0557278990',
      city: 'Accra',
      hasLicence: 'Yes',
      hearAbout: 'Facebook',
      message: 'Ready to start.',
    });

    const ticket = websiteIntakeTicket(parsed);
    expect(ticket).toMatchObject({
      source: 'website',
      source_form: 'car',
      application_type: 'car',
      from_name: 'Kofi Mensah',
      from_phone: '0557278990',
      status: 'Open',
      category: 'website_application',
      priority: 'Medium',
    });
    expect(String(ticket.message)).toContain('Application: Website Car Work & Pay application');
    expect(String(ticket.message)).toContain('Location: Accra');
  });

  it('requires a usable contact email and message for contact forms', () => {
    const parsed = websiteIntakeInput.safeParse({
      kind: 'contact',
      firstName: 'Ama',
      lastName: 'Owusu',
      email: 'not-an-email',
      message: '',
    });

    expect(parsed.success).toBe(false);
  });

  it('maps website complaints to a high-priority Support ticket', () => {
    const contact = websiteIntakeInput.parse({
      kind: 'contact',
      firstName: 'Ama',
      lastName: 'Owusu',
      email: 'ama@example.com',
      subject: 'complaint',
      message: 'Please call me about a completed trip.',
    });

    expect(websiteIntakeTicket(contact)).toMatchObject({
      subject: 'Website contact — complaint',
      category: 'complaint',
      priority: 'High',
      status: 'Open',
    });
  });

  it('uses a non-identifying rate-limit key and rejects the ninth request in the window', () => {
    const ip = '203.0.113.14';
    const key = websiteIntakeRateKey(ip);
    expect(key).toMatch(/^ip_[A-Za-z0-9_-]{43}$/);
    expect(key).not.toContain(ip);

    const now = Date.UTC(2026, 9, 6, 18, 0, 0);
    const attempts = Array.from({ length: 8 }, (_, index) => now - (7 - index) * 1_000);
    expect(allowsWebsiteIntake(attempts, now)).toBe(false);
    expect(allowsWebsiteIntake(attempts.slice(0, 7), now)).toBe(true);
  });
});
