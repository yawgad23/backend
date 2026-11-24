import type { DocumentSnapshot, Transaction } from 'firebase-admin/firestore';
import { ADMIN_COLLECTIONS, getAdminDb } from './firebaseAdmin';
import { driverApprovalState, type DriverApprovalState } from './driverApproval';
import {
  buildDriverDocumentManifest, DriverManifestError, driverManifestHash, validateDriverDocuments,
  type DriverDocumentKey, type DriverDocumentManifest,
} from './driverDocumentManifest';
import {
  driverManifestReadDependencies, isOwnedProfile,
  type DriverManifestProfileRecord, type DriverManifestReadDependencies,
} from './driverDocumentManifestRead';

export class AdminDriverVerificationError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string,
    public readonly missingDocuments?: DriverDocumentKey[]) {
    super(message);
    this.name = 'AdminDriverVerificationError';
  }
}

const PROFILE_CAP = 20;
function stale(): never {
  throw new AdminDriverVerificationError(409, 'DOCUMENT_REVISION_STALE', 'The Driver application changed. Refresh documents before deciding.');
}
function ownership(): never {
  throw new DriverManifestError(403, 'PROFILE_OWNERSHIP_CONFLICT', 'Driver profile ownership could not be confirmed.');
}
interface OwnedSelection {
  selected: DriverManifestProfileRecord;
  records: DriverManifestProfileRecord[];
  fingerprint: string;
}

/** Canonical wins; never merge documents or classify a test Driver from an alias. */
async function ownedSelection(uid: string, dependencies: DriverManifestReadDependencies): Promise<OwnedSelection> {
  const canonical = await dependencies.getProfile(uid);
  if (canonical && (canonical.id !== uid || !isOwnedProfile(canonical, uid, true))) ownership();
  const matches = await dependencies.listOwnedProfiles(uid);
  // The shared production reader requests 21 records: the extra record is a
  // truncation sentinel, not a silently discarded alias that might stay approved.
  if (matches.length > PROFILE_CAP) {
    throw new AdminDriverVerificationError(409, 'DRIVER_PROFILE_CAPACITY_EXCEEDED', 'Too many linked Driver profiles to safely review.');
  }
  const unique = new Map<string, DriverManifestProfileRecord>();
  for (const record of matches) {
    if (!record.id || !isOwnedProfile(record, uid, false)) ownership();
    if (unique.has(record.id)) {
      throw new AdminDriverVerificationError(409, 'DRIVER_PROFILE_AMBIGUOUS', 'Duplicate Driver profile records could not be confirmed.');
    }
    unique.set(record.id, record);
  }
  if (canonical) {
    const queryCanonical = unique.get(uid);
    if (queryCanonical && driverManifestHash(queryCanonical) !== driverManifestHash(canonical)) stale();
    unique.set(uid, canonical);
  } else if (unique.has(uid)) stale();
  const records = [...unique.values()].sort((a, b) => a.id.localeCompare(b.id));
  if (!records.length) throw new AdminDriverVerificationError(404, 'DRIVER_PROFILE_NOT_FOUND', 'Driver profile was not found.');
  if (!canonical && records.length !== 1) {
    throw new AdminDriverVerificationError(409, 'DRIVER_PROFILE_AMBIGUOUS', 'Multiple legacy Driver profiles require reconciliation before review.');
  }
  return { selected: canonical || records[0], records,
    fingerprint: driverManifestHash({ version: 1, canonical: canonical?.id || null, records }) };
}

async function validateAdminDocuments(uid: string, selection: OwnedSelection, dependencies: DriverManifestReadDependencies) {
  const observations: Array<{ objectPath: string; bucketName: string; metadata: unknown }> = [];
  const validated = await validateDriverDocuments(selection.selected.data, uid, dependencies.getBucketName(), async (bucketName, objectPath) => {
    const metadata = await dependencies.getMetadata(bucketName, objectPath);
    // Token metadata can change without an object-generation change. Bind the
    // exact token list and (when returned by Storage) metageneration as well.
    observations.push({ bucketName, objectPath, metadata: {
      generation: metadata.generation, metageneration: (metadata as { metageneration?: unknown }).metageneration,
      contentType: metadata.contentType, size: metadata.size,
      downloadTokens: metadata.metadata?.firebaseStorageDownloadTokens,
    } });
    return metadata;
  });
  observations.sort((a, b) => a.objectPath.localeCompare(b.objectPath));
  return { validated, metadataFingerprint: driverManifestHash(observations) };
}

function projectManifest(uid: string, selection: OwnedSelection, checked: Awaited<ReturnType<typeof validateAdminDocuments>>) {
  return buildDriverDocumentManifest({ uid, profileId: selection.selected.id, profile: selection.selected.data,
    profileFingerprint: driverManifestHash({ selection: selection.fingerprint, metadata: checked.metadataFingerprint }), validated: checked.validated });
}

export interface AdminDriverReview {
  profile: Record<string, unknown>;
  manifest: DriverDocumentManifest;
  selection: OwnedSelection;
}

/** Read-only, including the post-Storage ownership/version recheck. */
export async function readAdminDriverReview(
  uid: string, dependencies: DriverManifestReadDependencies = driverManifestReadDependencies,
): Promise<AdminDriverReview> {
  const selection = await ownedSelection(uid, dependencies);
  const checked = await validateAdminDocuments(uid, selection, dependencies);
  let current: OwnedSelection;
  try { current = await ownedSelection(uid, dependencies); }
  catch (error) {
    if (error instanceof DriverManifestError && error.status === 403
      || error instanceof AdminDriverVerificationError && error.status === 404) stale();
    throw error;
  }
  // An alias whose owner moved no longer occurs in the UID query. The fingerprint
  // includes all IDs, data and updateTimes so disappearance is still detected.
  if (selection.fingerprint !== current.fingerprint) stale();
  return { profile: { ...selection.selected.data, id: selection.selected.id, user_id: uid },
    manifest: projectManifest(uid, selection, checked), selection };
}

export function parseAdminDriverDecision(body: Record<string, unknown>): {
  approvalStatus: DriverApprovalState; reason: string | null; documentRevision: string;
} {
  const status = typeof body.approvalStatus === 'string' ? body.approvalStatus.trim().toLowerCase() : '';
  if (!['approved', 'rejected', 'pending'].includes(status)) {
    throw new AdminDriverVerificationError(400, 'DRIVER_APPROVAL_INVALID', 'Choose approved, rejected, or pending.');
  }
  if (body.documentRevision === undefined || body.documentRevision === null || body.documentRevision === '') {
    throw new AdminDriverVerificationError(409, 'DOCUMENT_REVISION_REQUIRED', 'Refresh Driver documents before deciding.');
  }
  if (typeof body.documentRevision !== 'string' || !/^[a-f0-9]{64}$/.test(body.documentRevision)) {
    throw new AdminDriverVerificationError(409, 'DOCUMENT_REVISION_INVALID', 'The document revision is invalid. Refresh Driver documents.');
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim().replace(/\s+/g, ' ') : '';
  if (status === 'rejected' && (reason.length < 3 || reason.length > 500)) {
    throw new AdminDriverVerificationError(400, 'DRIVER_REJECTION_REASON_REQUIRED', 'Enter a rejection reason of 3–500 characters.');
  }
  if (reason.length > 500) {
    throw new AdminDriverVerificationError(400, 'DRIVER_DECISION_REASON_INVALID', 'The decision reason must not exceed 500 characters.');
  }
  return { approvalStatus: status as DriverApprovalState, reason: reason || null, documentRevision: body.documentRevision };
}

function snapshotRecord(snapshot: DocumentSnapshot): DriverManifestProfileRecord | null {
  return snapshot.exists ? { id: snapshot.id, data: snapshot.data() || {},
    version: snapshot.updateTime?.toDate().toISOString() + ':' + snapshot.updateTime?.nanoseconds } : null;
}

function transactionDependencies(transaction: Transaction): DriverManifestReadDependencies {
  const collection = getAdminDb().collection(ADMIN_COLLECTIONS.DRIVER_PROFILES);
  return { ...driverManifestReadDependencies,
    async getProfile(id) { return snapshotRecord(await transaction.get(collection.doc(id))); },
    async listOwnedProfiles(uid) {
      const snapshot = await transaction.get(collection.where('user_id', '==', uid).orderBy('__name__').limit(PROFILE_CAP + 1));
      return snapshot.docs.map((document) => snapshotRecord(document)!);
    },
  };
}

/** Firestore profile/alias/presence/audit writes commit together or not at all.
 * Storage is revalidated inside EVERY attempt immediately before queued writes.
 * It cannot participate in the Firestore transaction: an overwrite after that
 * final check and before/after commit remains possible (no immutability claim).
 */
export async function decideAdminDriverApproval(uid: string, actor: string, body: Record<string, unknown>): Promise<{
  profile: Record<string, unknown>; documentRevision: string; reviewedManifest: DriverDocumentManifest;
}> {
  const decision = parseAdminDriverDecision(body);
  const reviewed = await readAdminDriverReview(uid);
  if (reviewed.manifest.documentRevision !== decision.documentRevision) stale();
  const db = getAdminDb();
  const auditRef = db.collection('account_lifecycle_events').doc();
  return db.runTransaction(async (transaction) => {
    const dependencies = transactionDependencies(transaction);
    let selection: OwnedSelection;
    try { selection = await ownedSelection(uid, dependencies); }
    catch (error) {
      if (error instanceof DriverManifestError && error.status === 403
        || error instanceof AdminDriverVerificationError && error.status === 404) stale();
      throw error;
    }
    if (selection.fingerprint !== reviewed.selection.fingerprint) stale();
    // Explicit point reads also lock every previously linked record, including
    // aliases whose ownership could otherwise move out of the query result.
    for (const record of reviewed.selection.records) {
      if (driverManifestHash(await dependencies.getProfile(record.id)) !== driverManifestHash(record)) stale();
    }
    const presenceRef = db.collection('driver_presence').doc(uid);
    const presence = decision.approvalStatus !== 'approved' ? await transaction.get(presenceRef) : null;
    if (presence?.exists && presence.data()?.user_id && presence.data()?.user_id !== uid) ownership();
    const checked = await validateAdminDocuments(uid, selection, dependencies);
    const manifest = projectManifest(uid, selection, checked);
    if (manifest.documentRevision !== decision.documentRevision) stale();
    const supervisedTest = selection.selected.data.is_test_driver === true;
    if (decision.approvalStatus === 'approved' && !manifest.documentsComplete && !supervisedTest) {
      throw new AdminDriverVerificationError(422, 'DRIVER_DOCUMENTS_INCOMPLETE',
        'All six required Driver documents must be valid before approval.', manifest.missingDocuments);
    }
    const now = new Date().toISOString();
    const approved = decision.approvalStatus === 'approved';
    const patch = {
      approval_status: decision.approvalStatus, application_status: decision.approvalStatus,
      approved, is_approved: approved, approval_updated_at: now, approval_updated_by: actor,
      rejection_reason: decision.approvalStatus === 'rejected' ? decision.reason : null,
      updated_date: now,
      ...(!approved ? { is_online: false, is_available: false, availability_status: 'offline' } : {}),
    };
    for (const record of selection.records) {
      // Legacy `status` can mean account lifecycle, so touch only approval aliases.
      const legacyStatus = typeof record.data.status === 'string' && ['approved', 'pending', 'rejected'].includes(record.data.status.trim().toLowerCase())
        ? { status: decision.approvalStatus } : {};
      transaction.update(db.collection(ADMIN_COLLECTIONS.DRIVER_PROFILES).doc(record.id), { ...patch, ...legacyStatus });
    }
    if (!approved) transaction.set(presenceRef, { user_id: uid, approval_status: decision.approvalStatus,
      approved: false, is_approved: false, is_online: false, is_available: false,
      availability_status: 'offline', offline_reason: `application_${decision.approvalStatus}`, updated_date: now }, { merge: true });
    transaction.create(auditRef, {
      user_id: uid, account_role: 'driver', action: 'driver_approval_decided',
      actor_type: 'administrator', actor_id: actor, created_date: now,
      previous_approval_status: driverApprovalState(selection.selected.data), new_approval_status: decision.approvalStatus,
      decision_reason: decision.reason, reviewed_document_revision: decision.documentRevision,
      exception: approved && supervisedTest && !manifest.documentsComplete ? 'supervised_test' : null,
      missing_documents: manifest.missingDocuments,
      linked_profiles: selection.records.map((record) => ({ profile_id: record.id,
        previous_approval_status: driverApprovalState(record.data), reviewed_record_version: record.version || null })),
    });
    // Returned only after runTransaction acknowledges a successful commit. The
    // reviewed revision is historical; clients re-fetch GET for a fresh manifest.
    return { profile: { ...selection.selected.data, ...patch, id: selection.selected.id, user_id: uid },
      documentRevision: decision.documentRevision, reviewedManifest: manifest };
  });
}
