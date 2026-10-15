import { normalizeAccountEmail, normalizeAccountPhone } from './accountContactClaims';

export type RequiredRiderIdentity = {
  fullName: string;
  email: string;
  phone: string;
};

const PLACEHOLDER_NAMES = new Set([
  'rider',
  'hy3n rider',
  'driver',
  'hy3n driver',
  'unknown',
  'unknown account',
  'unnamed',
  'unnamed account',
]);

export function requiredAccountFullName(value: unknown): string | null {
  const fullName = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (fullName.length < 2 || fullName.length > 120) return null;
  if (PLACEHOLDER_NAMES.has(fullName.toLowerCase())) return null;
  return fullName;
}

/**
 * Reads the account details that the server, rather than a mobile request,
 * trusts when a Rider requests a trip. Firebase Auth establishes the user;
 * the canonical profile establishes the contact details used operationally.
 */
export function requiredRiderIdentity(profile: Record<string, unknown> | null | undefined): RequiredRiderIdentity | null {
  if (!profile) return null;

  const fullName = requiredAccountFullName(profile.full_name ?? profile.name ?? profile.display_name);
  const email = normalizeAccountEmail(profile.email);
  const phone = normalizeAccountPhone(profile.phone ?? profile.phone_number ?? profile.mobile_number);
  if (!fullName || !email || !phone) return null;

  return { fullName, email, phone };
}

export function riderProfileCompletionMessage(): string {
  return 'Complete your full name, email address, and Ghana mobile number in your HY3N profile before requesting a ride.';
}
