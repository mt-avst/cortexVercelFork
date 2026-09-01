import { isAdminRole } from '../../../../shared/types';

describe('isAdminRole', () => {
  // These two pin the SET MEMBERSHIP that had no enforcement anywhere before the
  // predicate existed (cto/AdaptaLabs#57): "which roles are admin" used to be
  // spelled inline at 16 sites, so dropping a role from one was invisible to the
  // others. They are the named kills for the `is-admin-role-includes-*`
  // mutation-canary entries - drop either role from the predicate and exactly
  // one of these turns red. Pinned in BOTH directions on purpose: a single
  // assertion cannot see the OTHER role being removed.
  it('treats researcher_admin as an admin role', () => {
    expect(isAdminRole('researcher_admin')).toBe(true);
  });

  it('treats superadmin as an admin role', () => {
    expect(isAdminRole('superadmin')).toBe(true);
  });

  it('does not treat a plain employee as an admin role', () => {
    expect(isAdminRole('employee')).toBe(false);
  });

  it('treats an absent or unrecognised role as non-admin (fails closed)', () => {
    expect(isAdminRole(undefined)).toBe(false);
    expect(isAdminRole(null)).toBe(false);
    expect(isAdminRole('')).toBe(false);
    expect(isAdminRole('admin')).toBe(false);
  });
});
