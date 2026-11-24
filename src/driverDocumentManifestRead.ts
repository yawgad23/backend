import { getStorage } from 'firebase-admin/storage';
import { ADMIN_COLLECTIONS, getAdminApp, getAdminDb } from './firebaseAdmin';
import {
  buildDriverDocumentManifest, DriverManifestError, driverManifestHash, validateDriverDocuments,
  type DriverDocumentManifest, type DriverManifestProfile, type DriverMetadataGetter,
} from './driverDocumentManifest';

export interface DriverManifestProfileRecord {
  /** Firestore document ID, not the profile's untrusted stored id field. */
  id: string;
  data: DriverManifestProfile;
  /** Firestore update time detects even an otherwise-identical replacement. */
  version?: string;
}
export interface DriverManifestReadDependencies {
  getProfile: (profileId: string) => Promise<DriverManifestProfileRecord | null>;
  listOwnedProfiles: (uid: string) => Promise<DriverManifestProfileRecord[]>;
  getBucketName: () => string;
  getMetadata: DriverMetadataGetter;
  warn: (message: string) => void;
}

/** Explicit configuration is limited to the initialized Firebase project's standard buckets. */
export function resolveDriverDocumentBucket(projectId: string | undefined, configuredBucket?: string): string {
  const project = projectId || '';
  const bucket = configuredBucket || 'hy3n26.firebasestorage.app';
  if (!project || ![`${project}.firebasestorage.app`, `${project}.appspot.com`].includes(bucket)) {
    throw new DriverManifestError(503, 'DOCUMENT_STORAGE_UNAVAILABLE', 'Document storage configuration could not be confirmed. Please try again.');
  }
  return bucket;
}

const productionDependencies: DriverManifestReadDependencies = {
  async getProfile(profileId) {
    const snapshot = await getAdminDb().collection(ADMIN_COLLECTIONS.DRIVER_PROFILES).doc(profileId).get();
    return snapshot.exists ? { id: snapshot.id, data: snapshot.data() || {}, version: snapshot.updateTime?.toDate().toISOString() + ':' + snapshot.updateTime?.nanoseconds } : null;
  },
  async listOwnedProfiles(uid) {
    // Never email/phone queries or an unfiltered scan. A cap is sufficient to
    // detect duplicates; selection is stable and no unsupported records merge.
    const snapshot = await getAdminDb().collection(ADMIN_COLLECTIONS.DRIVER_PROFILES)
      .where('user_id', '==', uid).orderBy('__name__').limit(21).get();
    return snapshot.docs.map((document) => ({ id: document.id, data: document.data(),
      version: document.updateTime?.toDate().toISOString() + ':' + document.updateTime?.nanoseconds }));
  },
  getBucketName() {
    return resolveDriverDocumentBucket(getAdminApp().options.projectId, process.env.FIREBASE_STORAGE_BUCKET);
  },
  async getMetadata(bucketName, objectPath) {
    const [metadata] = await getStorage(getAdminApp()).bucket(bucketName).file(objectPath).getMetadata();
    return metadata;
  },
  warn(message) { console.warn(message); },
};

function isOwnedProfile(record: DriverManifestProfileRecord, uid: string, canonical: boolean): boolean {
  if (record.data.user_id === uid) return true;
  return canonical && record.id === uid && (record.data.user_id === undefined || record.data.user_id === null || record.data.user_id === '');
}

async function readOwnedSelection(uid: string, dependencies: DriverManifestReadDependencies, warn: boolean) {
  const canonical = await dependencies.getProfile(uid);
  if (canonical && (canonical.id !== uid || !isOwnedProfile(canonical, uid, true))) {
    throw new DriverManifestError(403, 'PROFILE_OWNERSHIP_CONFLICT', 'Your Driver profile ownership could not be confirmed. Please contact support.');
  }
  const matches = await dependencies.listOwnedProfiles(uid);
  const owned = matches.filter((record) => isOwnedProfile(record, uid, false) && record.id !== uid)
    .sort((left, right) => left.id.localeCompare(right.id));
  if (warn && ((canonical && owned.length > 0) || owned.length > 1)) {
    // No document URLs, identity data or account identifiers in warning logs.
    dependencies.warn('[Driver document manifest] Unsupported legacy duplicates exist; canonical data is not merged.');
  }
  return canonical || owned[0] || null;
}

function selectionFingerprint(record: DriverManifestProfileRecord | null): string {
  return driverManifestHash(record ? { id: record.id, data: record.data, version: record.version } : null);
}

/** All dependencies are reads; tests inject offline records and Storage metadata. */
export async function readDriverDocumentManifest(
  uid: string, dependencies: DriverManifestReadDependencies = productionDependencies,
): Promise<DriverDocumentManifest> {
  try {
    if (!uid || /[\/\\\s\x00-\x1f\x7f]/.test(uid) || uid === '.' || uid === '..') {
      throw new DriverManifestError(403, 'PROFILE_OWNERSHIP_CONFLICT', 'Your account identity could not be confirmed.');
    }
    const selected = await readOwnedSelection(uid, dependencies, true);
    const fingerprint = selectionFingerprint(selected);
    const validated = await validateDriverDocuments(selected?.data || null, uid, dependencies.getBucketName(), dependencies.getMetadata);
    // Re-read the UID canonical document and the very same legacy selection.
    // Appearance, disappearance, owner/status/reference/detail changes and
    // Firestore version changes all produce a refreshable conflict, never a
    // confirmation based on stale data.
    let current: DriverManifestProfileRecord | null;
    try {
      current = await readOwnedSelection(uid, dependencies, false);
    } catch (error) {
      if (error instanceof DriverManifestError && error.status === 403) {
        throw new DriverManifestError(409, 'DOCUMENT_MANIFEST_CHANGED', 'Your Driver application changed while documents were checked. Please refresh and try again.');
      }
      throw error;
    }
    if (selected && selected.id !== uid) {
      const sameLegacyRecord = await dependencies.getProfile(selected.id);
      if (fingerprint !== selectionFingerprint(sameLegacyRecord)) {
        throw new DriverManifestError(409, 'DOCUMENT_MANIFEST_CHANGED', 'Your Driver application changed while documents were checked. Please refresh and try again.');
      }
    }
    if (fingerprint !== selectionFingerprint(current)) {
      throw new DriverManifestError(409, 'DOCUMENT_MANIFEST_CHANGED', 'Your Driver application changed while documents were checked. Please refresh and try again.');
    }
    return buildDriverDocumentManifest({ uid, profileId: selected?.id || null, profile: selected?.data || null,
      profileFingerprint: fingerprint, validated });
  } catch (error) {
    if (error instanceof DriverManifestError) throw error;
    throw new DriverManifestError(503, 'DOCUMENT_MANIFEST_UNAVAILABLE', 'Your Driver application could not be checked. Please try again.');
  }
}
