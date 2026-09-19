import { describe, it, expect } from 'vitest';

import { rolesIntersect } from '../opportunityUtils';

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
