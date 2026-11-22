#!/usr/bin/env node
/**
 * Actual Firestore Rules emulator tests; Node >= 18, no npm dependencies.
 * Run ONLY using the dedicated demo emulator config documented in docs/.
 * REST requests use the Firebase SDK createMockUserToken-compatible unsigned
 * JWT structure; `Bearer owner` is ONLY for emulator fixture setup/inspection.
 * Tokens, contacts and photo URLs below are entirely synthetic.
 */
import assert from 'node:assert/strict';

const PROJECT = 'demo-hy3n-rider-photo';
const HOST = '127.0.0.1:8087';
assert.equal(process.env.FIRESTORE_EMULATOR_HOST, HOST,
  'Refusing to run: dedicated local FIRESTORE_EMULATOR_HOST must be 127.0.0.1:8087');
for (const name of ['GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT']) {
  if (process.env[name]) assert.equal(process.env[name], PROJECT, `${name} must be the demo project`);
}
const ROOT = `http://${HOST}`;
const DB = `${ROOT}/v1/projects/${PROJECT}/databases/(default)/documents`;
const CLEAR = `${ROOT}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`;
const UID = 'PhotoOwner_133-safe';
const FOREIGN = 'DifferentOwner_133';
const UUID = '12345678-1234-4abc-8def-1234567890ab'; // Not a real download token.
const ISO = '2026-11-22T11:00:00.000Z';
const urlFor = uid => `https://firebasestorage.googleapis.com/v0/b/hy3n26.firebasestorage.app/o/rider_profiles%2F${uid}%2Fprofile.jpg?alt=media&token=${UUID}`;
const PHOTO = urlFor(UID);
const PHOTO_PATCH = { profile_picture: PHOTO, updated_date: ISO };
const BASE = {
  user_id: UID, profile_picture: '', updated_date: '2026-11-21T10:00:00.000Z',
  full_name: 'Synthetic Test Rider', name: 'Synthetic Rider', fullName: 'Synthetic Rider',
  display_name: 'Synthetic Rider', email: 'fixture@example.invalid', phone: '+233200000000',
  phone_number: '+233200000000', role: 'rider', roles: ['rider'], is_admin: false,
  account_status: 'active', status: 'active', registration_source: 'rider_app',
  contact_claimed_at: '2026-11-21T10:00:00.000Z', loyalty_points: 0,
  loyalty_tier: 'Bronze', rating: 5, wallet_balance: 0, total_rides: 0,
  profile_completed: true, contact_claims: { email: 'synthetic-claim', phone: 'synthetic-claim' },
};

function mockToken(uid, email = 'fixture@example.invalid') {
  const iat = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', type: 'JWT' })}.${encode({
    iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT,
    iat, exp: iat + 3600, auth_time: iat, sub: uid, user_id: uid,
    ...(email === null ? {} : { email }),
    firebase: { sign_in_provider: 'custom', identities: {} },
  })}.`;
}
const AUTH = mockToken(UID);
const OTHER_AUTH = mockToken(FOREIGN);
const ADMIN = mockToken('SyntheticAdmin', 'active-admin@example.invalid');
const OWNER_ADMIN = mockToken('SyntheticProjectOwner', 'yawgad23@gmail.com');
const INACTIVE_ADMIN = mockToken('InactiveAdmin', 'inactive-admin@example.invalid');

function value(v) {
  if (v === null) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(value) } };
  return { mapValue: { fields: fields(v) } };
}
function fields(object) { return Object.fromEntries(Object.entries(object).map(([k, v]) => [k, value(v)])); }
function unwrap(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(unwrap);
  if ('mapValue' in v) return decoded(v.mapValue.fields || {});
  throw new Error('Unsupported fixture response value');
}
function decoded(f) { return Object.fromEntries(Object.entries(f).map(([k, v]) => [k, unwrap(v)])); }
async function rest(path, method = 'GET', token = null, body = undefined) {
  const response = await fetch(path, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10000),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}
function doc(collection, id) { return `${DB}/${collection}/${encodeURIComponent(id)}`; }
function permitted(result) { assert.equal(result.status, 200, JSON.stringify(result.body)); }
function denied(result) {
  assert.equal(result.status, 403, `Expected actual rules permission denial: ${JSON.stringify(result)}`);
  assert.equal(result.body.error?.status, 'PERMISSION_DENIED');
}
async function seed(id, data = BASE, collection = 'rider_profiles') {
  permitted(await rest(doc(collection, id), 'PATCH', 'owner', { fields: fields(data) }));
}
async function stored(id, collection = 'rider_profiles') {
  const result = await rest(doc(collection, id), 'GET', 'owner');
  permitted(result);
  return decoded(result.body.fields || {});
}
async function patch(id, data, token = AUTH, deleted = []) {
  const mask = new URLSearchParams();
  for (const k of [...Object.keys(data), ...deleted]) mask.append('updateMask.fieldPaths', k);
  mask.set('currentDocument.exists', 'true');
  return rest(`${doc('rider_profiles', id)}?${mask}`, 'PATCH', token, { fields: fields(data) });
}
let serial = 0;
let passed = 0;
let failed = 0;
async function test(name, action) {
  serial += 1;
  try { await action(`fixture-${serial}`); passed += 1; console.log(`ok ${serial} - ${name}`); }
  catch (error) { failed += 1; console.error(`not ok ${serial} - ${name}\n  ${error.stack}`); }
}
async function rejectsPatch(name, data, token = AUTH, base = BASE, deleted = []) {
  await test(name, async id => {
    await seed(id, base);
    denied(await patch(id, data, token, deleted));
    assert.deepEqual(await stored(id), base, 'Denied mutation must leave stored document unchanged');
  });
}

console.log(`TAP version 13\n# Actual Firestore emulator; ${PROJECT}; ${HOST}; synthetic fixtures only`);
try {
  permitted(await rest(CLEAR, 'DELETE', 'owner'));
  // Admin lookup keys are emails, not these setup names.
  await seed('active-admin@example.invalid', { is_active: true }, 'admin_access');
  await seed('inactive-admin@example.invalid', { is_active: false }, 'admin_access');

  // These preflight reads prove custom auth JWTs reach the real rules engine;
  // no negative test may pass merely due to invalid/unauthenticated tokens.
  await test('authenticated owner read succeeds (mock auth recognized)', async id => {
    await seed(id); permitted(await rest(doc('rider_profiles', id), 'GET', AUTH));
  });
  await test('owner photo update succeeds with NO email claim (Apple/custom sessions)', async id => {
    await seed(id);
    const token = mockToken(UID, null);
    permitted(await rest(doc('rider_profiles', id), 'GET', token));
    permitted(await patch(id, PHOTO_PATCH, token));
    assert.deepEqual(await stored(id), { ...BASE, ...PHOTO_PATCH });
  });
  await test('foreign read denied', async id => { await seed(id); denied(await rest(doc('rider_profiles', id), 'GET', OTHER_AUTH)); });
  await test('unauthenticated read denied', async id => { await seed(id); denied(await rest(doc('rider_profiles', id))); });

  for (const [name, id, uid] of [
    ['canonical UID document', UID, UID],
    ['owned legacy document ID differs from UID', 'legacy-profile-id-not-auth-uid', UID],
    ['minimum safe one-character UID', 'one-char-profile', 'A'],
    ['maximum safe 128-character UID', 'max-uid-profile', 'A'.repeat(128)],
    ['safe hyphen and underscore UID', 'safe-punctuation-profile', '_safe-133_'],
  ]) {
    await test(`own photo plus updated_date succeeds: ${name}`, async () => {
      const base = { ...BASE, user_id: uid };
      await seed(id, base);
      const change = { profile_picture: urlFor(uid), updated_date: ISO };
      permitted(await patch(id, change, mockToken(uid)));
      assert.deepEqual(await stored(id), { ...base, ...change }, 'All other fields must be preserved');
    });
  }
  await test('photo-only changed field permitted when valid timestamp is already present', async id => {
    await seed(id, { ...BASE, updated_date: ISO });
    permitted(await patch(id, { profile_picture: PHOTO }));
  });
  await test('same photo with new timestamp permitted', async id => {
    await seed(id, { ...BASE, profile_picture: PHOTO }); permitted(await patch(id, { updated_date: ISO }));
  });
  await test('valid ISO leap-day shape accepted', async id => {
    await seed(id); permitted(await patch(id, { ...PHOTO_PATCH, updated_date: '2024-02-29T23:59:59.999Z' }));
  });
  await test('uppercase UUID hex accepted', async id => {
    await seed(id); permitted(await patch(id, { ...PHOTO_PATCH, profile_picture: PHOTO.replace(UUID, UUID.toUpperCase()) }));
  });
  await rejectsPatch('no auth cannot update photo', PHOTO_PATCH, null);
  await rejectsPatch('foreign UID cannot update photo', PHOTO_PATCH, OTHER_AUTH);
  await rejectsPatch('foreign-owned document cannot be claimed by submitted user_id', { ...PHOTO_PATCH, user_id: UID }, AUTH, { ...BASE, user_id: FOREIGN });
  await test('foreign-owned document fails even when canonical ID equals session UID', async () => {
    const base = { ...BASE, user_id: FOREIGN }; await seed(UID, base);
    denied(await patch(UID, PHOTO_PATCH));
    denied(await patch(UID, { ...PHOTO_PATCH, user_id: UID }));
    assert.deepEqual(await stored(UID), base);
  });
  await rejectsPatch('missing existing ownership fails closed', PHOTO_PATCH, AUTH, Object.fromEntries(Object.entries(BASE).filter(([k]) => k !== 'user_id')));
  await rejectsPatch('null existing ownership fails closed', PHOTO_PATCH, AUTH, { ...BASE, user_id: null });

  const protectedChanges = {
    user_id: FOREIGN, full_name: 'Tampered Name', fullName: 'Tampered Name', name: 'Tampered Name',
    display_name: 'Tampered Name', email: 'tampered@example.invalid', phone: '+233200000001',
    phone_number: '+233200000001', role: 'admin', roles: ['admin'], is_admin: true,
    account_status: 'blocked', status: 'approved', registration_source: 'admin',
    contact_claimed_at: ISO, contact_claims: { email: 'changed' }, profile_completed: false,
    loyalty_points: 999, loyalty_tier: 'Gold', rating: 1, wallet_balance: 100000,
    total_rides: 999, wallet: { balance: 999 }, balance: 999, total_earnings: 999,
    approved: true, is_approved: true, permissions: ['admin'], custom_claims: { admin: true },
    uid: FOREIGN, auth_uid: FOREIGN, photo_url: PHOTO, arbitrary_new_field: 'blocked',
  };
  for (const [field, change] of Object.entries(protectedChanges)) {
    await rejectsPatch(`photo cannot also modify/add protected field ${field}`, { ...PHOTO_PATCH, [field]: change });
  }
  for (const field of Object.keys(BASE).filter(k => !['profile_picture', 'updated_date'].includes(k))) {
    await rejectsPatch(`photo cannot delete protected field ${field}`, PHOTO_PATCH, AUTH, BASE, [field]);
  }
  await rejectsPatch('direct contact/fullName save still denied', { full_name: 'Tampered Name', email: 'changed@example.invalid', phone: '+233200000001', updated_date: ISO });
  await rejectsPatch('direct name-only save still denied', { full_name: 'Tampered Name', updated_date: ISO });
  await rejectsPatch('direct financial save still denied', { wallet_balance: 999, updated_date: ISO });
  await test('full-document replacement cannot omit identity/contact/financial fields', async id => {
    await seed(id); denied(await rest(doc('rider_profiles', id), 'PATCH', AUTH, { fields: fields({ user_id: UID, ...PHOTO_PATCH }) }));
    assert.deepEqual(await stored(id), BASE);
  });
  await test('full-document replacement with all other fields unchanged remains photo-only', async id => {
    await seed(id); permitted(await rest(doc('rider_profiles', id), 'PATCH', AUTH, { fields: fields({ ...BASE, ...PHOTO_PATCH }) }));
    assert.deepEqual(await stored(id), { ...BASE, ...PHOTO_PATCH });
  });

  const badUrls = [
    ['external origin', 'https://example.invalid/profile.jpg'],
    ['foreign UID', urlFor(FOREIGN)],
    ['wrong bucket', PHOTO.replace('hy3n26.firebasestorage.app', 'other.firebasestorage.app')],
    ['old appspot bucket', PHOTO.replace('hy3n26.firebasestorage.app', 'hy3n26.appspot.com')],
    ['http scheme', PHOTO.replace('https:', 'http:')],
    ['host suffix attack', PHOTO.replace('googleapis.com/', 'googleapis.com.evil.invalid/')],
    ['userinfo host confusion', PHOTO.replace('https://', 'https://evil.invalid@')],
    ['different folder', PHOTO.replace('rider_profiles%2F', 'driver_profiles%2F')],
    ['arbitrary file', PHOTO.replace('profile.jpg', 'other.jpg')],
    ['path traversal', PHOTO.replace('%2Fprofile.jpg', '%2F..%2Fprofile.jpg')],
    ['unencoded slashes', PHOTO.replaceAll('%2F', '/')],
    ['double-encoded slashes', PHOTO.replaceAll('%2F', '%252F')],
    ['lowercase encoded slash', PHOTO.replaceAll('%2F', '%2f')],
    ['extra path suffix', PHOTO.replace('profile.jpg?', 'profile.jpg/extra?')],
    ['URL prefix whitespace', ` ${PHOTO}`], ['URL suffix whitespace', `${PHOTO} `],
    ['URL trailing newline', `${PHOTO}\n`], ['URL fragment', `${PHOTO}#fragment`],
    ['no query', PHOTO.split('?')[0]], ['empty query', `${PHOTO.split('?')[0]}?`],
    ['extra question mark', `${PHOTO}?extra`], ['query before path', PHOTO.replace('/o/', '/o/?')],
    ['reordered query', PHOTO.replace(`alt=media&token=${UUID}`, `token=${UUID}&alt=media`)],
    ['extra query param', `${PHOTO}&extra=1`], ['duplicate token', `${PHOTO}&token=${UUID}`],
    ['duplicate alt', `${PHOTO}&alt=media`], ['encoded ampersand', PHOTO.replace('&token=', '%26token=')],
    ['semicolon delimiter', PHOTO.replace('&token=', ';token=')],
    ['wrong alt', PHOTO.replace('alt=media', 'alt=json')], ['empty token', PHOTO.replace(UUID, '')],
    ['non UUID token', PHOTO.replace(UUID, 'arbitrary-token')], ['unhyphenated token', PHOTO.replace(UUID, UUID.replaceAll('-', ''))],
    ['UUID short', PHOTO.replace(UUID, UUID.slice(1))], ['UUID long', `${PHOTO}0`],
    ['nonhex UUID', PHOTO.replace(UUID, `g${UUID.slice(1)}`)], ['percent-encoded UUID', PHOTO.replace(UUID, `%31${UUID.slice(1)}`)],
    ['UUID query injection', PHOTO.replace(UUID, `${UUID}&admin=true`)],
    ['oversize string', 'x'.repeat(513)], ['empty string', ''], ['null value', null],
    ['number value', 42], ['map value', { url: PHOTO }], ['array value', [PHOTO]],
  ];
  for (const [name, profile_picture] of badUrls) await rejectsPatch(`reject photo URL: ${name}`, { ...PHOTO_PATCH, profile_picture });

  for (const uid of ['regex.*', 'regex|OtherUID', 'bad.dot', 'bad+plus', 'bad/slash', 'bad?query', 'space uid', 'café', 'A'.repeat(129)]) {
    await test(`custom UID outside safe ASCII set fails closed: ${JSON.stringify(uid)}`, async id => {
      await seed(id, { ...BASE, user_id: uid });
      const token = mockToken(uid);
      permitted(await rest(doc('rider_profiles', id), 'GET', token)); // Auth valid; rejection must be rules, not token parsing.
      denied(await patch(id, { ...PHOTO_PATCH, profile_picture: urlFor(uid) }, token));
    });
  }
  await test('regex-metacharacter UID cannot substitute another object path', async id => {
    const uid = 'Photo.*'; await seed(id, { ...BASE, user_id: uid });
    const token = mockToken(uid); permitted(await rest(doc('rider_profiles', id), 'GET', token));
    denied(await patch(id, PHOTO_PATCH, token));
  });

  const badDates = [
    ['null', null], ['number', 123], ['map', { seconds: 123 }], ['array', [ISO]], ['empty', ''],
    ['date only', '2026-11-22'], ['no milliseconds', '2026-11-22T11:00:00Z'],
    ['timezone offset', '2026-11-22T11:00:00.000+00:00'], ['lowercase t/z', ISO.toLowerCase()],
    ['extra suffix', `${ISO}x`], ['trailing newline', `${ISO}\n`], ['leading whitespace', ` ${ISO}`],
    ['month zero', '2026-00-22T11:00:00.000Z'], ['month 13', '2026-13-22T11:00:00.000Z'],
    ['day zero', '2026-11-00T11:00:00.000Z'], ['day 32', '2026-11-32T11:00:00.000Z'],
    ['hour 24', '2026-11-22T24:00:00.000Z'], ['minute 60', '2026-11-22T11:60:00.000Z'],
    ['second 60', '2026-11-22T11:00:60.000Z'], ['nondigits', 'abcd-ef-ghTij:kl:mn.opqZ'],
    ['oversize', ISO.repeat(30)],
  ];
  for (const [name, updated_date] of badDates) await rejectsPatch(`reject updated_date: ${name}`, { ...PHOTO_PATCH, updated_date });
  await rejectsPatch('photo update cannot delete updated_date', { profile_picture: PHOTO }, AUTH, BASE, ['updated_date']);
  await rejectsPatch('photo update cannot delete profile_picture', { updated_date: ISO }, AUTH, BASE, ['profile_picture']);
  await rejectsPatch('missing timestamp remains fail-closed', { profile_picture: PHOTO }, AUTH, Object.fromEntries(Object.entries(BASE).filter(([k]) => k !== 'updated_date')));
  await rejectsPatch('missing photo remains fail-closed', { updated_date: ISO }, AUTH, Object.fromEntries(Object.entries(BASE).filter(([k]) => k !== 'profile_picture')));

  for (const [name, token] of [['owner', AUTH], ['foreign', OTHER_AUTH], ['unauthenticated', null]]) {
    await test(`${name} cannot create Rider profile`, async id => {
      denied(await rest(doc('rider_profiles', id), 'PATCH', token, { fields: fields({ ...BASE, ...PHOTO_PATCH }) }));
    });
    await test(`${name} cannot delete Rider profile`, async id => { await seed(id); denied(await rest(doc('rider_profiles', id), 'DELETE', token)); });
  }
  await test('updateDoc cannot create missing legacy/canonical profile', async id => { denied(await patch(id, { user_id: UID, ...PHOTO_PATCH })); });
  await rejectsPatch('inactive admin cannot update foreign profile', { wallet_balance: 999 }, INACTIVE_ADMIN);
  for (const [name, token] of [['project owner email', OWNER_ADMIN], ['active admin_access', ADMIN]]) {
    await test(`${name} retains admin create/update/delete branch`, async id => {
      permitted(await rest(doc('rider_profiles', id), 'PATCH', token, { fields: fields(BASE) }));
      permitted(await patch(id, { user_id: FOREIGN, full_name: 'Admin Change', wallet_balance: 99, profile_picture: 'https://admin-fixture.invalid/photo', updated_date: 'admin-timestamp' }, token));
      permitted(await rest(doc('rider_profiles', id), 'DELETE', token));
    });
  }
  for (const [name, token] of [['owner', AUTH], ['foreign', OTHER_AUTH], ['unauthenticated', null], ['active admin', ADMIN], ['project owner', OWNER_ADMIN]]) {
    for (const operation of ['read', 'create', 'update', 'delete']) {
      await test(`${name} cannot ${operation} backend-only contact claim`, async id => {
        const path = doc('account_contact_claims', id);
        if (operation !== 'create') await seed(id, { owner_uid: UID, role: 'rider', hash: 'synthetic' }, 'account_contact_claims');
        denied(await rest(path, operation === 'read' ? 'GET' : operation === 'delete' ? 'DELETE' : 'PATCH', token,
          ['create', 'update'].includes(operation) ? { fields: fields({ owner_uid: FOREIGN, hash: 'tampered' }) } : undefined));
      });
    }
  }
  await test('Rider photo rule grants no Driver profile update', async id => {
    await seed(id, BASE, 'driver_profiles'); denied(await rest(doc('driver_profiles', id), 'PATCH', AUTH, { fields: fields({ ...BASE, ...PHOTO_PATCH }) }));
  });
  await test('Rider photo rule grants no wallet write', async id => {
    await seed(UID, { balance: 0 }, 'wallets'); denied(await rest(doc('wallets', UID), 'PATCH', AUTH, { fields: fields({ balance: 999 }) }));
  });
  await test('Rider photo rule grants no unlisted collection write', async id => {
    denied(await rest(doc('unlisted_photo_test', id), 'PATCH', AUTH, { fields: fields(PHOTO_PATCH) }));
  });
} finally {
  // Dedicated demo project only; no fixtures retained and no prod connection.
  permitted(await rest(CLEAR, 'DELETE', 'owner'));
}
console.log(`1..${serial}\n# ${passed} passed; ${failed} failed`);
if (failed) process.exitCode = 1;
