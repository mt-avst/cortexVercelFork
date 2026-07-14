import { describe, expect, it } from '@jest/globals';

import {
  parseBootstrapSuperadminEmails,
  shouldElevateToSuperadmin,
} from '../superadminBootstrap';

describe('parseBootstrapSuperadminEmails', () => {
  it('returns an empty list when unset or blank', () => {
    expect(parseBootstrapSuperadminEmails(undefined)).toEqual([]);
    expect(parseBootstrapSuperadminEmails('')).toEqual([]);
    expect(parseBootstrapSuperadminEmails('   ,  , ')).toEqual([]);
  });

  it('trims, lowercases and de-duplicates', () => {
    expect(
      parseBootstrapSuperadminEmails('  Nfine@Adaptavist.com , other@x.com ,nfine@adaptavist.com')
    ).toEqual(['nfine@adaptavist.com', 'other@x.com']);
  });
});

describe('shouldElevateToSuperadmin', () => {
  const bootstrap = ['nfine@adaptavist.com', 'other@x.com'];

  it('elevates a listed non-superadmin, case-insensitively', () => {
    expect(shouldElevateToSuperadmin('nfine@adaptavist.com', 'employee', bootstrap)).toBe(true);
    expect(shouldElevateToSuperadmin('NFine@Adaptavist.com', 'researcher_admin', bootstrap)).toBe(true);
  });

  it('does not elevate someone already superadmin (no redundant write)', () => {
    expect(shouldElevateToSuperadmin('nfine@adaptavist.com', 'superadmin', bootstrap)).toBe(false);
  });

  it('does not elevate an email that is not listed', () => {
    expect(shouldElevateToSuperadmin('stranger@x.com', 'employee', bootstrap)).toBe(false);
  });

  it('never elevates when the bootstrap list is empty', () => {
    expect(shouldElevateToSuperadmin('nfine@adaptavist.com', 'employee', [])).toBe(false);
  });
});
