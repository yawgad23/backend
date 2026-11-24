import { describe, expect, it, vi } from 'vitest';
import {
  DRIVER_DOCUMENT_DEFINITIONS, DRIVER_DOCUMENT_MAX_BYTES, DriverManifestError,
  driverDocumentKeys, parseDriverStorageReference, validateDriverDocumentReference,
  validateDriverDocuments, driverManifestHash,
} from './driverDocumentManifest';
import {
  readDriverDocumentManifest, resolveDriverDocumentBucket,
  type DriverManifestProfileRecord, type DriverManifestReadDependencies,
} from './driverDocumentManifestRead';

const uid = 'driver-1';
const bucket = 'hy3n26.firebasestorage.app';
const url = (path: string, bucketName = bucket) => `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(path)}?alt=media&token=test-token`;
const metadata = { contentType: 'image/jpeg', size: '1024', generation: '12345', metadata: { firebaseStorageDownloadTokens: 'test-token' } };
function allDocuments() {
  return Object.fromEntries(driverDocumentKeys.filter((key) => DRIVER_DOCUMENT_DEFINITIONS[key].required)
    .map((key) => [DRIVER_DOCUMENT_DEFINITIONS[key].field, url(`drivers/${uid}/${key}.jpg`)]));
}
function dependencies(record: DriverManifestProfileRecord | null = null): DriverManifestReadDependencies {
  return {
    getProfile: vi.fn(async (id: string) => record?.id === id ? structuredClone(record) : null),
    listOwnedProfiles: vi.fn(async () => record?.id !== uid && record ? [record] : []),
    getBucketName: vi.fn(() => bucket), getMetadata: vi.fn(async () => metadata), warn: vi.fn(),
  };
}
function record(data: Record<string, unknown> = {}): DriverManifestProfileRecord {
  return { id: uid, data: { user_id: uid, ...data }, version: 'v1' };
}

describe('UID-owned Firebase document URL parsing (no URL fetches)', () => {
  it('accepts only both supported owned prefixes', () => {
    for (const prefix of ['drivers', 'driver-documents']) {
      const reference = url(`${prefix}/${uid}/ghana-card-front.jpg`);
      expect(parseDriverStorageReference(reference, uid, bucket)).toEqual({ bucketName: bucket,
        objectPath: `${prefix}/${uid}/ghana-card-front.jpg`, reference });
    }
  });
  it.each([
    '', 'file:///tmp/photo.jpg', 'content://photo/123', '/tmp/photo.jpg', 'photo.jpg', 'not a url',
    'http://firebasestorage.googleapis.com/v0/b/hy3n26.firebasestorage.app/o/drivers%2Fdriver-1%2Fphoto.jpg?alt=media&token=test',
    'https://example.com/photo.jpg', 'https://storage.googleapis.com/hy3n26.firebasestorage.app/drivers/driver-1/photo.jpg',
    url(`drivers/${uid}/photo.jpg`, 'foreign.firebasestorage.app'), url('drivers/driver-2/photo.jpg'),
    url(`rider_profiles/${uid}/photo.jpg`), url(`drivers/${uid}/../photo.jpg`), url(`drivers/${uid}/./photo.jpg`),
    url(`drivers/${uid}//photo.jpg`), url(`drivers/${uid}/%2e%2e/photo.jpg`), url(`drivers/${uid}/%2Fphoto.jpg`),
    url(`drivers/${uid}/photo\\bad.jpg`), url(`drivers/${uid}/photo\n.jpg`), url(`drivers/${uid}/`),
    url(`drivers/${uid}/photo.jpg`) + '#fragment', url(`drivers/${uid}/photo.jpg`).replace('?alt=media', '?alt=json'),
    url(`drivers/${uid}/photo.jpg`).replace('&token=test-token', ''),
    url(`drivers/${uid}/photo.jpg`) + '&generation=999',
    url(`drivers/${uid}/photo.jpg`).replace('/o/', '/o/junk/../'),
    'https://firebasestorage.googleapis.com/v0/b/hy3n26.firebasestorage.app/o/%ZZ?alt=media&token=x',
  ])('rejects unsafe or malformed reference %s', (reference) => {
    expect(parseDriverStorageReference(reference, uid, bucket)).toBeNull();
  });
  it('never reaches metadata for untrusted references', async () => {
    const getter = vi.fn();
    for (const reference of [url('drivers/another/photo.jpg'), 'file:///photo', 'https://example.com/photo']) {
      expect(await validateDriverDocumentReference(reference, uid, bucket, getter)).toMatchObject({ status: 'invalid', reference: null });
    }
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('Storage existence, MIME, size and outage checks', () => {
  it.each(['image/jpeg', 'image/png', 'image/webp'])('permits %s with nonzero size at limit', async (contentType) => {
    const reference = url(`drivers/${uid}/image.jpg`);
    expect(await validateDriverDocumentReference(reference, uid, bucket, async () => ({ ...metadata, contentType, size: DRIVER_DOCUMENT_MAX_BYTES })))
      .toMatchObject({ status: 'valid', reference, generation: metadata.generation });
  });
  it.each([
    { ...metadata, size: 0 }, { ...metadata, size: -1 }, { ...metadata, size: DRIVER_DOCUMENT_MAX_BYTES + 1 },
    { ...metadata, size: 'garbage' }, { ...metadata, size: '1e3' }, { ...metadata, size: 1.5 },
    { ...metadata, contentType: 'application/pdf' }, { ...metadata, contentType: 'image/svg+xml' },
    { ...metadata, contentType: 'image/gif' }, { ...metadata, contentType: undefined },
  ])('invalidates unusable metadata %#', async (invalidMetadata) => {
    expect(await validateDriverDocumentReference(url(`drivers/${uid}/image.jpg`), uid, bucket, async () => invalidMetadata))
      .toMatchObject({ status: 'invalid', reference: null });
  });
  it('treats deleted objects as invalid and does not expose their URL', async () => {
    expect(await validateDriverDocumentReference(url(`drivers/${uid}/image.jpg`), uid, bucket, async () => { throw { code: 404 }; }))
      .toMatchObject({ status: 'invalid', reference: null });
  });
  it.each([{ code: 403 }, { code: 401 }, { code: 'EAI_AGAIN' }, new Error('network'), { code: 500 }])('preserves unknown Storage failures as 503 %#', async (error) => {
    await expect(validateDriverDocumentReference(url(`drivers/${uid}/image.jpg`), uid, bucket, async () => { throw error; }))
      .rejects.toMatchObject({ status: 503, code: 'DOCUMENT_STORAGE_UNAVAILABLE' });
  });
  it('does not confirm an unversioned object', async () => {
    await expect(validateDriverDocumentReference(url(`drivers/${uid}/image.jpg`), uid, bucket, async () => ({ ...metadata, generation: undefined })))
      .rejects.toMatchObject({ status: 503 });
  });
  it.each([undefined, { firebaseStorageDownloadTokens: '' }, { firebaseStorageDownloadTokens: 'different-token' }])('does not return a URL with missing/revoked/fake download token %#', async (storedMetadata) => {
    expect(await validateDriverDocumentReference(url(`drivers/${uid}/image.jpg`), uid, bucket, async () => ({ ...metadata, metadata: storedMetadata })))
      .toMatchObject({ status: 'invalid', reference: null, generation: metadata.generation });
  });
  it('accepts a matching token among Firebase multi-token metadata', async () => {
    expect(await validateDriverDocumentReference(url(`drivers/${uid}/image.jpg`), uid, bucket, async () => ({ ...metadata,
      metadata: { firebaseStorageDownloadTokens: 'older-token,test-token' } }))).toMatchObject({ status: 'valid' });
  });
});

describe('read-only manifest contract', () => {
  it('returns a missing profile as a pending empty incomplete manifest, not 404', async () => {
    const deps = dependencies();
    const manifest = await readDriverDocumentManifest(uid, deps);
    expect(manifest).toMatchObject({ userId: uid, profileId: null, approvalStatus: 'pending', documentsComplete: false,
      missingDocuments: ['ghanaCardFront', 'ghanaCardBack', 'licenseFront', 'licenseBack', 'profilePhoto', 'vehiclePhoto'],
      details: { fullName: '', email: '', phone: '', momoNumber: '', city: '', serviceType: '', acceptedCategories: [],
        vehicleMake: '', vehicleModel: '', vehiclePlate: '', vehicleColor: '', vehicleYear: '' } });
    expect(Object.values(manifest.documents).every((document) => document.status === 'missing' && document.reference === null)).toBe(true);
    expect(manifest.documentRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(deps.getMetadata).not.toHaveBeenCalled();
  });
  it('reports zero files as incomplete even for an approved profile', async () => {
    const manifest = await readDriverDocumentManifest(uid, dependencies(record({ approval_status: 'approved' })));
    expect(manifest.profileId).toBe(uid);
    expect(manifest.approvalStatus).toBe('approved');
    expect(manifest.documentsComplete).toBe(false);
    expect(manifest.missingDocuments).toHaveLength(6);
  });
  it('reports partial documents by keys and only returns confirmed URL references', async () => {
    const manifest = await readDriverDocumentManifest(uid, dependencies(record({ ghana_card_front_url: url(`drivers/${uid}/front.jpg`),
      ghana_card_back_url: 'file:///back.jpg' })));
    expect(manifest.documents.ghanaCardFront.status).toBe('valid');
    expect(manifest.documents.ghanaCardBack).toMatchObject({ status: 'invalid', reference: null });
    expect(manifest.missingDocuments).toEqual(['ghanaCardBack', 'licenseFront', 'licenseBack', 'profilePhoto', 'vehiclePhoto']);
  });
  it('all six required files with optional absence are complete but do not autoapprove', async () => {
    const deps = dependencies(record({ ...allDocuments(), approval_status: 'pending', approved: true, is_approved: true,
      full_name: 'Kofi Mensah', email: 'kofi@example.com', phone: '+233244000111', momo_number: '+233244000111',
      city: 'Accra', service_type: 'car', accepted_categories: ['standard', 'comfort'], vehicle_make: 'Toyota',
      vehicle_model: 'Corolla', license_plate: 'GR 1234', vehicle_colour: 'White', vehicle_year: 2024 }));
    const manifest = await readDriverDocumentManifest(uid, deps);
    expect(manifest.documentsComplete).toBe(true);
    expect(manifest.missingDocuments).toEqual([]);
    expect(manifest.approvalStatus).toBe('pending');
    expect(manifest.documents.insurance).toMatchObject({ required: false, status: 'missing', reference: null });
    expect(manifest.documents.roadworthy).toMatchObject({ required: false, status: 'missing', reference: null });
    expect(manifest.details).toEqual({ fullName: 'Kofi Mensah', email: 'kofi@example.com', phone: '+233244000111',
      momoNumber: '+233244000111', city: 'Accra', serviceType: 'car', acceptedCategories: ['standard', 'comfort'],
      vehicleMake: 'Toyota', vehicleModel: 'Corolla', vehiclePlate: 'GR 1234', vehicleColor: 'White', vehicleYear: '2024' });
  });
  it('preserves rejected canonical approval over every legacy approved alias', async () => {
    const manifest = await readDriverDocumentManifest(uid, dependencies(record({ approval_status: 'rejected',
      application_status: 'approved', status: 'approved', approved: true, is_approved: true })));
    expect(manifest.approvalStatus).toBe('rejected');
  });
  it('canonical wins over an approved legacy duplicate without merging fields', async () => {
    const deps = dependencies(record({ approval_status: 'pending', full_name: 'Canonical' }));
    deps.listOwnedProfiles = vi.fn(async () => [{ id: 'legacy', data: { user_id: uid, approval_status: 'approved', ...allDocuments(), email: 'legacy@example.com' } }]);
    const manifest = await readDriverDocumentManifest(uid, deps);
    expect(manifest.profileId).toBe(uid);
    expect(manifest.documentsComplete).toBe(false);
    expect(manifest.approvalStatus).toBe('pending');
    expect(manifest.details.email).toBe('');
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('not merged'));
    expect(deps.listOwnedProfiles).toHaveBeenCalledWith(uid);
  });
  it('uses an owned user_id legacy profile only when canonical is absent', async () => {
    const legacy = { id: 'legacy-1', data: { user_id: uid, ...allDocuments() } };
    const manifest = await readDriverDocumentManifest(uid, dependencies(legacy));
    expect(manifest.profileId).toBe('legacy-1');
    expect(manifest.documentsComplete).toBe(true);
  });
  it('allows UID canonical with absent legacy user_id but rejects a conflicting owner', async () => {
    expect((await readDriverDocumentManifest(uid, dependencies({ id: uid, data: allDocuments() }))).documentsComplete).toBe(true);
    await expect(readDriverDocumentManifest(uid, dependencies(record({ user_id: 'another' }))))
      .rejects.toMatchObject({ status: 403, code: 'PROFILE_OWNERSHIP_CONFLICT' });
  });
  it('rejects false legacy id/owner matches and does not recover via contact identity', async () => {
    const deps = dependencies();
    deps.listOwnedProfiles = vi.fn(async () => [{ id: uid, data: { email: 'same@example.com' } },
      { id: 'foreign', data: { user_id: 'another', email: 'same@example.com' } }]);
    expect((await readDriverDocumentManifest(uid, deps)).profileId).toBeNull();
  });
  it('selects multiple owned legacy records deterministically, warns, and does not merge', async () => {
    const deps = dependencies({ id: 'a', data: { user_id: uid, approval_status: 'pending' } });
    deps.listOwnedProfiles = vi.fn(async () => [{ id: 'z', data: { user_id: uid, ...allDocuments(), approval_status: 'approved' } },
      { id: 'a', data: { user_id: uid, approval_status: 'pending' } }]);
    expect((await readDriverDocumentManifest(uid, deps)).profileId).toBe('a');
    expect(deps.warn).toHaveBeenCalled();
  });
  it.each(['vehicle-photo.jpg', 'vehicle_photo.jpg'])('permits legacy photo basename %s', async (name) => {
    const validated = await validateDriverDocuments({ vehicle_registration_url: url(`driver-documents/${uid}/${name}`) }, uid, bucket, async () => metadata);
    expect(validated.vehiclePhoto.status).toBe('valid');
  });
  it.each(['registration.jpg', 'vehicle-registration.jpg', 'vehicle-photo.png'])('does not count arbitrary historical registration %s', async (name) => {
    const deps = dependencies(record({ vehicle_registration_url: url(`drivers/${uid}/${name}`) }));
    const manifest = await readDriverDocumentManifest(uid, deps);
    expect(manifest.documents.vehiclePhoto).toMatchObject({ status: 'invalid', reference: null });
    expect(deps.getMetadata).not.toHaveBeenCalled();
  });
  it('does not use legacy photo to mask a present invalid current photo reference', async () => {
    const validated = await validateDriverDocuments({ vehicle_photo_url: 'file:///bad', vehicle_registration_url: url(`drivers/${uid}/vehicle-photo.jpg`) }, uid, bucket, async () => metadata);
    expect(validated.vehiclePhoto.status).toBe('invalid');
  });
  it('does not return a manifest declaring files missing when Storage is unknown', async () => {
    const deps = dependencies(record(allDocuments()));
    deps.getMetadata = vi.fn(async () => { throw { code: 403 }; });
    await expect(readDriverDocumentManifest(uid, deps)).rejects.toMatchObject({ status: 503 });
  });
});

describe('revision stability and stale confirmation guard', () => {
  it('hashes deterministically irrespective of field insertion order', () => {
    expect(driverManifestHash({ a: 1, b: { c: 2, d: 3 } })).toBe(driverManifestHash({ b: { d: 3, c: 2 }, a: 1 }));
  });
  it('revision binds UID/profileId/approval/current references and Storage generation', async () => {
    const initial = await readDriverDocumentManifest(uid, dependencies(record(allDocuments())));
    expect((await readDriverDocumentManifest(uid, dependencies(record(allDocuments())))).documentRevision).toBe(initial.documentRevision);
    const changedGeneration = dependencies(record(allDocuments()));
    changedGeneration.getMetadata = async () => ({ ...metadata, generation: '12346' });
    expect((await readDriverDocumentManifest(uid, changedGeneration)).documentRevision).not.toBe(initial.documentRevision);
    for (const changes of [{ approval_status: 'rejected' }, { ghana_card_front_url: url(`drivers/${uid}/other.jpg`) }]) {
      expect((await readDriverDocumentManifest(uid, dependencies(record({ ...allDocuments(), ...changes })))).documentRevision).not.toBe(initial.documentRevision);
    }
    expect((await readDriverDocumentManifest(uid, dependencies({ id: 'legacy', data: { user_id: uid, ...allDocuments() } }))).documentRevision).not.toBe(initial.documentRevision);
  });
  it.each(['reference', 'approval', 'details', 'version', 'disappearance', 'ownership'])('fails 409 when %s changes during metadata reads', async (change) => {
    const original = record(allDocuments());
    const deps = dependencies(original);
    let changed = false;
    deps.getMetadata = async () => { changed = true; return metadata; };
    deps.getProfile = async () => {
      if (!changed) return original;
      if (change === 'disappearance') return null;
      return { ...original, version: change === 'version' ? 'v2' : original.version,
        data: { ...original.data,
          ...(change === 'reference' ? { ghana_card_front_url: url(`drivers/${uid}/new.jpg`) } : {}),
          ...(change === 'approval' ? { approval_status: 'rejected' } : {}),
          ...(change === 'details' ? { full_name: 'Changed' } : {}),
          ...(change === 'ownership' ? { user_id: 'other' } : {}),
        } };
    };
    await expect(readDriverDocumentManifest(uid, deps)).rejects.toMatchObject({ status: 409, code: 'DOCUMENT_MANIFEST_CHANGED' });
  });
  it('fails 409 when a canonical record appears while legacy documents are checked', async () => {
    const deps = dependencies({ id: 'legacy', data: { user_id: uid, ...allDocuments() } });
    let changed = false;
    const getProfile = deps.getProfile;
    deps.getMetadata = async () => { changed = true; return metadata; };
    deps.getProfile = async (id) => changed && id === uid ? record(allDocuments()) : getProfile(id);
    await expect(readDriverDocumentManifest(uid, deps)).rejects.toMatchObject({ status: 409 });
  });
  it('fails 409 on same legacy profile disappearance', async () => {
    const deps = dependencies({ id: 'legacy', data: { user_id: uid, ...allDocuments() } });
    let changed = false;
    deps.getMetadata = async () => { changed = true; return metadata; };
    deps.getProfile = async () => null;
    deps.listOwnedProfiles = async () => changed ? [] : [{ id: 'legacy', data: { user_id: uid, ...allDocuments() } }];
    await expect(readDriverDocumentManifest(uid, deps)).rejects.toMatchObject({ status: 409 });
  });
  it('Firestore outages are 503, never an empty profile', async () => {
    const deps = dependencies();
    deps.getProfile = async () => { throw new Error('IAM/network unavailable'); };
    await expect(readDriverDocumentManifest(uid, deps)).rejects.toBeInstanceOf(DriverManifestError);
    await expect(readDriverDocumentManifest(uid, deps)).rejects.toMatchObject({ status: 503 });
  });
});

describe('bucket isolation', () => {
  it('accepts the known default or explicit bucket belonging to the initialized project', () => {
    expect(resolveDriverDocumentBucket('hy3n26')).toBe(bucket);
    expect(resolveDriverDocumentBucket('hy3n26', 'hy3n26.appspot.com')).toBe('hy3n26.appspot.com');
    expect(resolveDriverDocumentBucket('another', 'another.firebasestorage.app')).toBe('another.firebasestorage.app');
  });
  it.each([['another', undefined], ['hy3n26', 'foreign.firebasestorage.app'], [undefined, undefined], ['hy3n26', 'gs://hy3n26.firebasestorage.app']])('rejects mismatched Storage configuration %#', (project, configured) => {
    expect(() => resolveDriverDocumentBucket(project, configured)).toThrow(DriverManifestError);
  });
});
