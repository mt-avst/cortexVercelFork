import { describe, it, expect } from '@jest/globals';
import { Pool } from 'pg';
import { buildSessionStore, usePostgresSessionStore } from '../sessionStore';

/**
 * Login sessions move to Postgres only where a process-local MemoryStore is
 * wrong (Vercel: many function instances) or where it is asked for. The
 * single-replica Kubera deployment sets neither, and must keep MemoryStore -
 * `undefined` is what tells express-session to use it.
 */
describe('session store selection', () => {
  // Never connects: pg.Pool opens connections lazily, and nothing here queries.
  const pool = new Pool({ connectionString: 'postgresql://unused@localhost:1/unused' });

  it('keeps MemoryStore when neither VERCEL nor SESSION_STORE is set (Kubera today)', () => {
    expect(usePostgresSessionStore({})).toBe(false);
    expect(buildSessionStore(pool, {})).toBeUndefined();
  });

  it('uses Postgres on Vercel', () => {
    expect(usePostgresSessionStore({ VERCEL: '1' })).toBe(true);
    expect(buildSessionStore(pool, { VERCEL: '1' })).toBeDefined();
  });

  it('uses Postgres when SESSION_STORE=postgres opts in elsewhere', () => {
    expect(usePostgresSessionStore({ SESSION_STORE: 'postgres' })).toBe(true);
  });

  it('ignores any other SESSION_STORE value', () => {
    expect(usePostgresSessionStore({ SESSION_STORE: 'redis' })).toBe(false);
  });
});
