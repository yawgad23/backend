import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const rules = readFileSync(resolve(process.cwd(), 'firestore.rules'), 'utf8');

describe('Driver presence Firestore access', () => {
  it('does not grant every signed-in Rider access to general Driver presence', () => {
    expect(rules).toContain('match /driver_presence/{driverId}');
    expect(rules).toContain('allow read: if isAdmin() || (signedIn() && request.auth.uid == driverId);');
    expect(rules).not.toContain('match /driver_presence/{driverId} { allow read: if signedIn();');
  });
});
