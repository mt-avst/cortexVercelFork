import { describe, it, expect } from 'vitest';

import {
  opportunityMatchesRoles,
  resolveActiveMatchRoles,
  rolesIntersect,
} from '../opportunityUtils';
import type { Opportunity } from '../../api/types';

describe('rolesIntersect', () => {
  it('is true when the two sets share an entry', () => {
    expect(rolesIntersect(['Product Manager', 'Designer'], ['Designer'])).toBe(true);
  });

  it('is case-insensitive and trims', () => {
    expect(rolesIntersect(['Jira admin'], ['  jira ADMIN  '])).toBe(true);
  });

  it('is false when the sets are disjoint', () => {
    expect(rolesIntersect(['Product Manager'], ['QA Engineer'])).toBe(false);
  });

  it('is false when either side is empty or nullish', () => {
    expect(rolesIntersect([], ['Designer'])).toBe(false);
    expect(rolesIntersect(['Designer'], [])).toBe(false);
    expect(rolesIntersect(null, ['Designer'])).toBe(false);
    expect(rolesIntersect(['Designer'], undefined)).toBe(false);
  });
});

describe('resolveActiveMatchRoles (precedence)', () => {
  it('prefers the transient browse-as override over the saved profile', () => {
    expect(resolveActiveMatchRoles(['Designer'], ['Product Manager'])).toEqual(['Designer']);
  });

  it('falls back to the saved profile when there is no override', () => {
    expect(resolveActiveMatchRoles(null, ['Product Manager'])).toEqual(['Product Manager']);
    expect(resolveActiveMatchRoles([], ['Product Manager'])).toEqual(['Product Manager']);
  });

  it('is empty when neither is set (no matching, browse still works)', () => {
    expect(resolveActiveMatchRoles(null, [])).toEqual([]);
    expect(resolveActiveMatchRoles(undefined, undefined)).toEqual([]);
  });
});

describe('opportunityMatchesRoles', () => {
  const opp = (target_roles: string[] | undefined): Pick<Opportunity, 'target_roles'> =>
    ({ target_roles } as Pick<Opportunity, 'target_roles'>);

  it('matches when the advertised audience intersects the active set', () => {
    expect(opportunityMatchesRoles(opp(['Designer', 'QA Engineer']), ['designer'])).toBe(true);
  });

  it('does not match a study that advertises no audience', () => {
    expect(opportunityMatchesRoles(opp(undefined), ['Designer'])).toBe(false);
    expect(opportunityMatchesRoles(opp([]), ['Designer'])).toBe(false);
  });

  it('does not match when the active set is empty', () => {
    expect(opportunityMatchesRoles(opp(['Designer']), [])).toBe(false);
  });
});
