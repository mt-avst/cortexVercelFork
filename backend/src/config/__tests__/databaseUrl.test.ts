import { describe, expect, it } from '@jest/globals';

import { resolveDatabaseUrl } from '../databaseUrl';

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
});
