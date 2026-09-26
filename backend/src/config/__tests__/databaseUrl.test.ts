import { describe, expect, it } from '@jest/globals';

import { describeDatabaseUrlSource, hasDatabaseConfig, resolveDatabaseUrl } from '../databaseUrl';

describe('resolveDatabaseUrl', () => {
  it('prefers an explicit DATABASE_URL over everything else', () => {
    const url = resolveDatabaseUrl({
      DATABASE_URL: 'postgresql://a:b@generic-host:5432/generic',
      DB_URL: 'postgresql://c:d@kubera-host:5432/kubera',
    });
    expect(url).toBe('postgresql://a:b@generic-host:5432/generic');
  });

  it('falls back to POSTGRES_URL, then POSTGRESQL_URL', () => {
    expect(resolveDatabaseUrl({ POSTGRES_URL: 'postgresql://vercel-host/db' })).toBe(
      'postgresql://vercel-host/db'
    );
    expect(resolveDatabaseUrl({ POSTGRESQL_URL: 'postgresql://other-host/db' })).toBe(
      'postgresql://other-host/db'
    );
  });

  it('reads DB_URL - the variable Kubera actually injects', () => {
    const url = resolveDatabaseUrl({ DB_URL: 'postgresql://kubera-rds-host:5432/adaptalabs' });
    expect(url).toBe('postgresql://kubera-rds-host:5432/adaptalabs');
  });

  it('constructs a connection string from Kubera individual vars (DB_HOST etc)', () => {
    const url = resolveDatabaseUrl({
      DB_HOST: 'rds.internal',
      DB_PORT: '5432',
      DB_NAME: 'adaptalabs',
      DB_USER: 'app_user',
      DB_PASSWORD: 'p@ss w/ord',
    });
    expect(url).toBe('postgresql://app_user:p%40ss%20w%2Ford@rds.internal:5432/adaptalabs');
  });

  it('constructs a connection string from the generic PG* vars as a fallback', () => {
    const url = resolveDatabaseUrl({
      POSTGRES_HOST: 'generic.internal',
      POSTGRES_PORT: '5433',
      POSTGRES_DB: 'mydb',
      POSTGRES_USER: 'me',
      POSTGRES_PASSWORD: 'secret',
    });
    expect(url).toBe('postgresql://me:secret@generic.internal:5433/mydb');
  });

  it('prefers Kubera host vars over generic PG* host vars when both are present', () => {
    const url = resolveDatabaseUrl({
      DB_HOST: 'kubera.internal',
      DB_USER: 'kubera_user',
      DB_PASSWORD: 'kubera_pass',
      DB_NAME: 'kubera_db',
      POSTGRES_HOST: 'generic.internal',
    });
    expect(url).toContain('kubera.internal');
    expect(url).not.toContain('generic.internal');
  });

  it('defaults port and database name when only a host is given', () => {
    const url = resolveDatabaseUrl({ DB_HOST: 'bare-host' });
    expect(url).toBe('postgresql://postgres:@bare-host:5432/postgres');
  });

  it('falls back to the local dev database when nothing is configured', () => {
    expect(resolveDatabaseUrl({})).toBe('postgresql://localhost:5432/adaptalabs_dev');
  });

  it('trims whitespace and surrounding quotes from a full URL (secret managers often inject these)', () => {
    expect(resolveDatabaseUrl({ DB_URL: '  postgresql://host/db\n' })).toBe(
      'postgresql://host/db'
    );
    expect(resolveDatabaseUrl({ DB_URL: '"postgresql://host/db"' })).toBe(
      'postgresql://host/db'
    );
  });

  it('trims whitespace and newlines from individual host/user/password vars', () => {
    const url = resolveDatabaseUrl({
      DB_HOST: 'rds.internal\n',
      DB_USER: ' postgres ',
      DB_PASSWORD: 'sekrit\n',
      DB_NAME: 'adaptalabs',
    });
    expect(url).toBe('postgresql://postgres:sekrit@rds.internal:5432/adaptalabs');
  });
});

describe('hasDatabaseConfig', () => {
  it('is true for every source resolveDatabaseUrl accepts, not just DATABASE_URL', () => {
    // Regression: deleting the stale DATABASE_URL from the Kubera secret store
    // (the fix for the week-long outage) silently flipped isDatabaseAvailable()
    // into mock-data mode, because it only checked DATABASE_URL while the pool
    // happily connected via Kubera's injected DB_URL/DB_HOST.
    expect(hasDatabaseConfig({ DATABASE_URL: 'postgresql://h/db' })).toBe(true);
    expect(hasDatabaseConfig({ POSTGRES_URL: 'postgresql://h/db' })).toBe(true);
    expect(hasDatabaseConfig({ POSTGRESQL_URL: 'postgresql://h/db' })).toBe(true);
    expect(hasDatabaseConfig({ DB_URL: 'postgresql://h/db' })).toBe(true);
    expect(hasDatabaseConfig({ DB_HOST: 'rds.internal' })).toBe(true);
    expect(hasDatabaseConfig({ POSTGRES_HOST: 'generic.internal' })).toBe(true);
    expect(hasDatabaseConfig({ PGHOST: 'pg.internal' })).toBe(true);
  });

  it('is false when nothing is configured (local dev mock-data mode)', () => {
    expect(hasDatabaseConfig({})).toBe(false);
  });

  it('is false when the only values present are blank after trimming', () => {
    expect(hasDatabaseConfig({ DATABASE_URL: '  \n', DB_HOST: '' })).toBe(false);
  });
});

describe('describeDatabaseUrlSource', () => {
  it('identifies a Kubera DB_URL as the source without revealing it', () => {
    const description = describeDatabaseUrlSource({
      DB_URL: 'postgresql://user:hunter2@host/db',
    });
    expect(description).toBe('DB_URL (Kubera full URL)');
    expect(description).not.toContain('hunter2');
  });

  it('reports the Kubera individual-vars path and whether a password is present', () => {
    expect(
      describeDatabaseUrlSource({ DB_HOST: 'h', DB_PASSWORD: 'sekrit' })
    ).toBe('DB_HOST (Kubera individual vars), password: present (6 chars)');

    expect(describeDatabaseUrlSource({ DB_HOST: 'h' })).toBe(
      'DB_HOST (Kubera individual vars), password: MISSING'
    );

    expect(
      describeDatabaseUrlSource({ DB_HOST: 'h', DB_PASSWORD: '  \n' })
    ).toBe('DB_HOST (Kubera individual vars), password: MISSING (blank after trim)');
  });

  it('flags the generic PG* host fallback distinctly from Kubera', () => {
    expect(
      describeDatabaseUrlSource({ POSTGRES_HOST: 'h', POSTGRES_PASSWORD: 'x' })
    ).toBe('POSTGRES_HOST (generic fallback), password: present (1 chars)');
  });

  it('warns loudly when nothing resolved and the localhost dev fallback will be used', () => {
    expect(describeDatabaseUrlSource({})).toBe(
      'NONE FOUND - falling back to localhost dev database (this is wrong outside local dev!)'
    );
  });
});

/**
 * On Vercel the database is Neon, from the two variables its integration sets,
 * and nothing else (owner, 2026-09-25): no localhost default, no Kubera DB_URL /
 * DB_HOST, no generic PG* - a missing Neon connection fails loudly instead.
 */
describe('on Vercel, only Neon', () => {
  const NEON = 'postgresql://u:p@ep-cool-name-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require';

  it('uses DATABASE_URL, then POSTGRES_URL', () => {
    expect(resolveDatabaseUrl({ VERCEL: '1', DATABASE_URL: NEON, POSTGRES_URL: 'postgresql://other/db' })).toBe(NEON);
    expect(resolveDatabaseUrl({ VERCEL: '1', POSTGRES_URL: NEON })).toBe(NEON);
  });

  it('throws instead of falling back to localhost when neither is set', () => {
    expect(() => resolveDatabaseUrl({ VERCEL: '1' })).toThrow(/only to Neon/);
  });

  it.each([
    ['DB_URL', { DB_URL: 'postgresql://kubera-rds/db' }],
    ['DB_HOST', { DB_HOST: 'kubera-rds', DB_PASSWORD: 'x' }],
    ['PGHOST', { PGHOST: 'somewhere' }],
    ['POSTGRESQL_URL', { POSTGRESQL_URL: 'postgresql://elsewhere/db' }],
  ])('ignores %s', (_name, env) => {
    expect(() => resolveDatabaseUrl({ VERCEL: '1', ...env })).toThrow(/only to Neon/);
    expect(hasDatabaseConfig({ VERCEL: '1', ...env })).toBe(false);
  });

  it('treats a blank Neon variable as missing', () => {
    expect(() => resolveDatabaseUrl({ VERCEL: '1', DATABASE_URL: '   ' })).toThrow(/only to Neon/);
  });

  it('names the source for the boot log without the value', () => {
    expect(describeDatabaseUrlSource({ VERCEL: '1', DATABASE_URL: NEON })).toBe('DATABASE_URL (Neon, Vercel)');
    expect(describeDatabaseUrlSource({ VERCEL: '1' })).toMatch(/^NONE/);
  });

  it('leaves off-Vercel resolution exactly as it was (control)', () => {
    expect(resolveDatabaseUrl({ DB_URL: 'postgresql://kubera-rds/db' })).toBe('postgresql://kubera-rds/db');
    expect(resolveDatabaseUrl({})).toBe('postgresql://localhost:5432/adaptalabs_dev');
  });
});
