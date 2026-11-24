import { createHash } from 'node:crypto';
import type { DriverApprovalState } from './driverApproval';
import { driverApprovalState } from './driverApproval';

export const DRIVER_DOCUMENT_DEFINITIONS = {
  ghanaCardFront: { label: 'Ghana Card (Front)', required: true, field: 'ghana_card_front_url' },
  ghanaCardBack: { label: 'Ghana Card (Back)', required: true, field: 'ghana_card_back_url' },
  licenseFront: { label: "Driver's License (Front)", required: true, field: 'drivers_license_front_url' },
  licenseBack: { label: "Driver's License (Back)", required: true, field: 'drivers_license_back_url' },
  profilePhoto: { label: 'Your Photo (Selfie)', required: true, field: 'profile_photo_url' },
  vehiclePhoto: { label: 'Vehicle Photo', required: true, field: 'vehicle_photo_url' },
  insurance: { label: 'Insurance', required: false, field: 'insurance_url' },
  roadworthy: { label: 'Roadworthy', required: false, field: 'roadworthy_url' },
} as const;

export type DriverDocumentKey = keyof typeof DRIVER_DOCUMENT_DEFINITIONS;
export type DriverDocumentStatus = 'valid' | 'missing' | 'invalid';
export type DriverManifestProfile = Record<string, unknown>;
export interface DriverManifestDocument {
  label: string;
  required: boolean;
  status: DriverDocumentStatus;
  reference: string | null;
}
export interface DriverManifestDetails {
  fullName: string;
  email: string;
  phone: string;
  momoNumber: string;
  city: string;
  serviceType: string;
  acceptedCategories: string[];
  vehicleMake: string;
  vehicleModel: string;
  vehiclePlate: string;
  vehicleColor: string;
  vehicleYear: string;
}
export interface DriverDocumentManifest {
  userId: string;
  profileId: string | null;
  approvalStatus: DriverApprovalState;
  documentsComplete: boolean;
  documentRevision: string;
  /** Required document keys, not labels. Includes both missing and invalid files. */
  missingDocuments: DriverDocumentKey[];
  documents: Record<DriverDocumentKey, DriverManifestDocument>;
  details: DriverManifestDetails;
}
export interface DriverStorageMetadata {
  contentType?: unknown;
  size?: unknown;
  generation?: unknown;
  metadata?: Record<string, unknown>;
}
export type DriverMetadataGetter = (bucketName: string, objectPath: string) => Promise<DriverStorageMetadata>;
export interface ParsedDriverStorageReference { bucketName: string; objectPath: string; reference: string }
export interface ValidatedDriverDocument {
  status: DriverDocumentStatus;
  reference: string | null;
  generation: string | null;
  contentType: string | null;
  size: number | null;
}
export type ValidatedDriverDocuments = Record<DriverDocumentKey, ValidatedDriverDocument>;

export class DriverManifestError extends Error {
  constructor(public readonly status: 403 | 409 | 503, public readonly code: string, message: string) {
    super(message);
    this.name = 'DriverManifestError';
  }
}

export const DRIVER_DOCUMENT_MAX_BYTES = 8 * 1024 * 1024;
const imageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
export const driverDocumentKeys = Object.keys(DRIVER_DOCUMENT_DEFINITIONS) as DriverDocumentKey[];

/** No network access: only known Firebase download URLs and UID-owned paths. */
export function parseDriverStorageReference(value: unknown, uid: string, bucketName: string): ParsedDriverStorageReference | null {
  if (typeof value !== 'string' || !value || value.length > 4_000 || value !== value.trim()) return null;
  if (!uid || /[\/\\%\s\x00-\x1f\x7f]/.test(uid) || uid === '.' || uid === '..') return null;
  if (!/^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\//.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'firebasestorage.googleapis.com'
      || url.username || url.password || url.port || url.hash) return null;
    if (url.pathname !== value.split('?')[0].slice('https://firebasestorage.googleapis.com'.length)) return null;
    const parts = /^\/v0\/b\/([^/]+)\/o\/([^/]+)$/.exec(url.pathname);
    if (!parts || parts[1] !== bucketName) return null;
    if (url.searchParams.getAll('alt').length !== 1 || url.searchParams.get('alt') !== 'media'
      || url.searchParams.getAll('token').length !== 1 || !/^[A-Za-z0-9_-]+$/.test(url.searchParams.get('token') || '')) return null;
    for (const key of url.searchParams.keys()) if (key !== 'alt' && key !== 'token') return null;
    const objectPath = decodeURIComponent(parts[2]);
    // Decode once only. Reject encoded aliases, traversal, separators and controls.
    if (/[\\%\s\x00-\x1f\x7f?#]/.test(objectPath)) return null;
    const segments = objectPath.split('/');
    if (segments.length < 3 || !['drivers', 'driver-documents'].includes(segments[0])
      || segments[1] !== uid || segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
    return { bucketName, objectPath, reference: value };
  } catch {
    return null;
  }
}

export function driverDocumentReference(profile: DriverManifestProfile | null, key: DriverDocumentKey): unknown {
  return profile?.[DRIVER_DOCUMENT_DEFINITIONS[key].field];
}

function noReference(status: 'missing' | 'invalid'): ValidatedDriverDocument {
  return { status, reference: null, generation: null, contentType: null, size: null };
}

export function isDriverStorageNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  return candidate.code === 404 || candidate.code === '404' || candidate.statusCode === 404 || candidate.response?.status === 404;
}

export async function validateDriverDocumentReference(
  value: unknown, uid: string, bucketName: string, getMetadata: DriverMetadataGetter,
): Promise<ValidatedDriverDocument> {
  if (value === undefined || value === null || value === '') return noReference('missing');
  const parsed = parseDriverStorageReference(value, uid, bucketName);
  if (!parsed) return noReference('invalid');
  let metadata: DriverStorageMetadata;
  try {
    metadata = await getMetadata(parsed.bucketName, parsed.objectPath);
  } catch (error) {
    if (isDriverStorageNotFound(error)) return noReference('invalid');
    throw new DriverManifestError(503, 'DOCUMENT_STORAGE_UNAVAILABLE', 'Document storage could not be checked. Please try again.');
  }
  const contentType = typeof metadata?.contentType === 'string' ? metadata.contentType : '';
  const rawSize = metadata?.size;
  const size = typeof rawSize === 'number' ? rawSize : typeof rawSize === 'string' && /^\d+$/.test(rawSize) ? Number(rawSize) : NaN;
  const generation = typeof metadata.generation === 'string' || typeof metadata.generation === 'number'
    ? String(metadata.generation) : '';
  if (!/^\d+$/.test(generation)) {
    throw new DriverManifestError(503, 'DOCUMENT_STORAGE_UNAVAILABLE', 'Document storage version could not be confirmed. Please try again.');
  }
  const downloadTokens = metadata.metadata?.firebaseStorageDownloadTokens;
  const token = new URL(parsed.reference).searchParams.get('token');
  const tokenMatches = typeof downloadTokens === 'string' && downloadTokens.split(',').map((value) => value.trim()).includes(token || '');
  if (!imageTypes.has(contentType) || !Number.isSafeInteger(size) || size <= 0 || size > DRIVER_DOCUMENT_MAX_BYTES || !tokenMatches) {
    return { status: 'invalid', reference: null, generation, contentType: contentType || null,
      size: Number.isSafeInteger(size) ? size : null };
  }
  return { status: 'valid', reference: parsed.reference, generation, contentType, size };
}

export async function validateDriverDocuments(
  profile: DriverManifestProfile | null, uid: string, bucketName: string, getMetadata: DriverMetadataGetter,
): Promise<ValidatedDriverDocuments> {
  const entries = await Promise.all(driverDocumentKeys.map(async (key) => {
    let reference = driverDocumentReference(profile, key);
    if (key === 'vehiclePhoto' && (reference === undefined || reference === null || reference === '')) {
      const legacy = profile?.vehicle_registration_url;
      const parsed = parseDriverStorageReference(legacy, uid, bucketName);
      const basename = parsed?.objectPath.split('/').at(-1);
      // Historical registration scans are NOT a substitute for the vehicle photo.
      if (basename === 'vehicle-photo.jpg' || basename === 'vehicle_photo.jpg') reference = legacy;
      else if (legacy !== undefined && legacy !== null && legacy !== '') return [key, noReference('invalid')] as const;
    }
    return [key, await validateDriverDocumentReference(reference, uid, bucketName, getMetadata)] as const;
  }));
  return Object.fromEntries(entries) as ValidatedDriverDocuments;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}
export function driverManifestDetails(profile: DriverManifestProfile | null): DriverManifestDetails {
  const data = profile || {};
  const categories = data.accepted_categories ?? data.ride_categories;
  return {
    fullName: text(data.full_name), email: text(data.email), phone: text(data.phone),
    momoNumber: text(data.momo_number), city: text(data.city), serviceType: text(data.service_type),
    acceptedCategories: Array.isArray(categories) ? [...new Set(categories.filter((category): category is string => typeof category === 'string').map((category) => category.trim()).filter(Boolean))] : [],
    vehicleMake: text(data.vehicle_make), vehicleModel: text(data.vehicle_model),
    vehiclePlate: text(data.vehicle_plate || data.license_plate), vehicleColor: text(data.vehicle_color || data.vehicle_colour),
    vehicleYear: text(data.vehicle_year),
  };
}

function stableValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    if (value instanceof Date) return value.toISOString();
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, stableValue(child)]));
  }
  return value;
}
export function driverManifestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

/** Pure projection; completeness never changes administrator approval. */
export function buildDriverDocumentManifest(input: {
  uid: string; profileId: string | null; profile: DriverManifestProfile | null;
  profileFingerprint: string; validated: ValidatedDriverDocuments;
}): DriverDocumentManifest {
  const approvalStatus = driverApprovalState(input.profile);
  const documents = Object.fromEntries(driverDocumentKeys.map((key) => [key, {
    label: DRIVER_DOCUMENT_DEFINITIONS[key].label,
    required: DRIVER_DOCUMENT_DEFINITIONS[key].required,
    status: input.validated[key].status,
    reference: input.validated[key].status === 'valid' ? input.validated[key].reference : null,
  }])) as Record<DriverDocumentKey, DriverManifestDocument>;
  const missingDocuments = driverDocumentKeys.filter((key) => documents[key].required && documents[key].status !== 'valid');
  return {
    userId: input.uid, profileId: input.profileId, approvalStatus,
    documentsComplete: missingDocuments.length === 0,
    documentRevision: driverManifestHash({ version: 1, uid: input.uid, profileId: input.profileId,
      approvalStatus, profileFingerprint: input.profileFingerprint,
      currentReferences: driverDocumentKeys.map((key) => [key, driverDocumentReference(input.profile, key)]),
      legacyVehicleReference: input.profile?.vehicle_registration_url,
      storage: input.validated }),
    missingDocuments, documents, details: driverManifestDetails(input.profile),
  };
}
