import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DriverManifestError } from './driverDocumentManifest';

const mocks = vi.hoisted(() => ({ verifyIdToken: vi.fn(), readManifest: vi.fn(), set: vi.fn(), update: vi.fn(), create: vi.fn(),
  listAll: vi.fn(), get: vi.fn(), list: vi.fn(), claim: vi.fn() }));
vi.mock('./firebaseAdmin', () => ({ ADMIN_COLLECTIONS: { DRIVER_PROFILES: 'driver_profiles', RIDER_PROFILES: 'rider_profiles' },
  getAdminAuth: () => ({ verifyIdToken: mocks.verifyIdToken }),
  adminFirestore: { set: mocks.set, update: mocks.update, create: mocks.create, listAll: mocks.listAll, get: mocks.get, list: mocks.list } }));
vi.mock('./accountContactClaims', async (importOriginal) => ({ ...(await importOriginal<typeof import('./accountContactClaims')>()),
  claimAccountContacts: mocks.claim }));
vi.mock('./driverDocumentManifestRead', () => ({ readDriverDocumentManifest: mocks.readManifest }));
import { registerAccountProfileRoutes } from './accountProfileRoutes';

const minimalManifest = { userId: 'own-uid', profileId: null, approvalStatus: 'pending', documentsComplete: false,
  documentRevision: 'abc', missingDocuments: ['ghanaCardFront'], documents: {}, details: {} };
let server: ReturnType<ReturnType<typeof express>['listen']>;
let origin: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  registerAccountProfileRoutes(app);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyIdToken.mockResolvedValue({ uid: 'own-uid', email: 'owner@example.com' });
  mocks.readManifest.mockResolvedValue(minimalManifest);
});

describe('GET /api/account/profile/driver/documents authentication and contract', () => {
  it('rejects anonymous callers without reading documents; all responses are no-store', async () => {
    const response = await fetch(`${origin}/api/account/profile/driver/documents`);
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ success: false, code: 'AUTH_REQUIRED' });
    expect(mocks.verifyIdToken).not.toHaveBeenCalled();
    expect(mocks.readManifest).not.toHaveBeenCalled();
  });
  it('requires Firebase revocation checking and rejects revoked/expired tokens', async () => {
    mocks.verifyIdToken.mockRejectedValueOnce(new Error('revoked token'));
    const response = await fetch(`${origin}/api/account/profile/driver/documents`, { headers: { Authorization: 'Bearer revoked' } });
    expect(response.status).toBe(401);
    expect(mocks.verifyIdToken).toHaveBeenCalledWith('revoked', true);
    expect(mocks.readManifest).not.toHaveBeenCalled();
  });
  it('returns the exact success wrapper with a token-only UID target, ignoring email/userId query', async () => {
    const response = await fetch(`${origin}/api/account/profile/driver/documents?userId=foreign&email=foreign@example.com`, {
      headers: { Authorization: 'Bearer valid-token' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.verifyIdToken).toHaveBeenCalledWith('valid-token', true);
    expect(mocks.readManifest).toHaveBeenCalledWith('own-uid');
    expect(await response.json()).toEqual({ success: true, manifest: minimalManifest });
    for (const write of [mocks.set, mocks.update, mocks.create, mocks.claim, mocks.listAll]) expect(write).not.toHaveBeenCalled();
  });
  it.each([
    [403, 'PROFILE_OWNERSHIP_CONFLICT'], [409, 'DOCUMENT_MANIFEST_CHANGED'], [503, 'DOCUMENT_STORAGE_UNAVAILABLE'],
  ] as const)('propagates a safe %i error without a misleading success/missing manifest', async (status, code) => {
    mocks.readManifest.mockRejectedValueOnce(new DriverManifestError(status, code, 'Please retry.'));
    const response = await fetch(`${origin}/api/account/profile/driver/documents`, { headers: { Authorization: 'Bearer valid' } });
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ success: false, code, message: 'Please retry.' });
  });
  it('does not leak backend errors and returns unknown as 503', async () => {
    mocks.readManifest.mockRejectedValueOnce(new Error('private backend error'));
    const response = await fetch(`${origin}/api/account/profile/driver/documents`, { headers: { Authorization: 'Bearer valid' } });
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).not.toContain('private backend error');
    expect(body).not.toContain('manifest');
  });
  it('registers through the existing account routes without changing submission/approval logic', () => {
    const appSource = readFileSync(resolve(process.cwd(), 'src/app.ts'), 'utf8');
    expect(appSource).toContain('registerAccountProfileRoutes(app)');
    const routeSource = readFileSync(resolve(process.cwd(), 'src/accountProfileRoutes.ts'), 'utf8');
    const getHandler = routeSource.split("app.get('/api/account/profile/driver/documents'")[1].split("app.post('/api/account/profile/rider'")[0];
    expect(getHandler).toContain('authenticatedIdentity(request, response)');
    expect(getHandler).toContain('readDriverDocumentManifest(session.uid)');
    expect(getHandler).not.toMatch(/claimAccountContacts|adminFirestore\.(set|create|update|delete)|writeCanonicalProfile|legacyRiderRecovery/);
    const readSource = readFileSync(resolve(process.cwd(), 'src/driverDocumentManifestRead.ts'), 'utf8');
    expect(readSource).toContain(".where('user_id', '==', uid)");
    expect(readSource).toContain('getStorage(getAdminApp()).bucket(bucketName).file(objectPath).getMetadata()');
    expect(readSource).not.toMatch(/\.set\(|\.update\(|\.create\(|\.delete\(|\.add\(|fetch\(|axios|claimAccountContacts|listAll/);
  });
});
