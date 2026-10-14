import { describe, expect, it } from 'vitest';
import { newest, sortProfilesNewestFirst } from './adminAccountRoutes';

describe('admin account profile ordering', () => {
  it('keeps legacy Rider profiles with no created_date visible', () => {
    const legacyRider = {
      id: 'legacy-rider',
      user_id: 'rider-legacy',
      full_name: 'Legacy Rider',
      updated_date: '2026-10-14T01:00:00.000Z',
    };
    const currentRider = {
      id: 'current-rider',
      user_id: 'rider-current',
      full_name: 'Current Rider',
      created_date: '2026-10-14T02:00:00.000Z',
    };

    expect(sortProfilesNewestFirst([legacyRider, currentRider]).map((profile) => profile.id))
      .toEqual(['current-rider', 'legacy-rider']);
  });

  it('selects the most recently active duplicate Rider profile', () => {
    const first = { id: 'old', user_id: 'rider-1', created_date: '2026-10-10T10:00:00.000Z' };
    const second = { id: 'new', user_id: 'rider-1', updated_date: '2026-10-11T10:00:00.000Z' };

    expect(newest(first, second)).toBe(second);
  });
});
