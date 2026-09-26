import { describe, expect, it } from 'vitest';
import { createAdministratorAccessProof, verifyAdministratorAccessProof } from './adminAccessCode';

describe('administrator access-code proof', () => {
  const email = 'admin@example.com';
  const accessCode = 'Code-Only-For-Test';
  const now = 1_700_000_000_000;

  it('accepts a signed proof for the matching administrator before expiry', () => {
    const proof = createAdministratorAccessProof(email, accessCode, now + 60_000);
    expect(verifyAdministratorAccessProof(email, accessCode, proof, now)).toBe(true);
  });

  it('rejects a proof for another administrator, another code, or an expired proof', () => {
    const proof = createAdministratorAccessProof(email, accessCode, now + 60_000);
    expect(verifyAdministratorAccessProof('other@example.com', accessCode, proof, now)).toBe(false);
    expect(verifyAdministratorAccessProof(email, 'different-code', proof, now)).toBe(false);
    expect(verifyAdministratorAccessProof(email, accessCode, proof, now + 60_001)).toBe(false);
  });

  it('rejects malformed proofs', () => {
    expect(verifyAdministratorAccessProof(email, accessCode, 'not-a-proof', now)).toBe(false);
  });
});
