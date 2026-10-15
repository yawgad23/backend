import { describe, expect, it } from 'vitest';
import { requiredAccountFullName, requiredRiderIdentity, riderProfileCompletionMessage } from './riderIdentity';

describe('server-owned Rider identity', () => {
  it('returns only normalized complete profile identity', () => {
    expect(requiredRiderIdentity({
      full_name: '  Ama   Mensah ',
      email: ' AMA@EXAMPLE.COM ',
      phone: '024 123 4567',
    })).toEqual({
      fullName: 'Ama Mensah',
      email: 'ama@example.com',
      phone: '+233241234567',
    });
  });

  it('rejects unnamed and incomplete legacy profiles', () => {
    expect(requiredRiderIdentity({
      full_name: 'Unnamed account',
      email: 'rider@example.com',
      phone: '0241234567',
    })).toBeNull();
    expect(requiredRiderIdentity({
      full_name: 'Ama Mensah',
      email: '',
      phone: '0241234567',
    })).toBeNull();
    expect(requiredRiderIdentity({
      full_name: 'Ama Mensah',
      email: 'rider@example.com',
      phone: '',
    })).toBeNull();
    expect(riderProfileCompletionMessage()).toContain('full name, email address, and Ghana mobile number');
  });

  it('rejects placeholder names for either type of account', () => {
    expect(requiredAccountFullName('Driver')).toBeNull();
    expect(requiredAccountFullName('Unknown account')).toBeNull();
    expect(requiredAccountFullName('Kwame Asante')).toBe('Kwame Asante');
  });
});
