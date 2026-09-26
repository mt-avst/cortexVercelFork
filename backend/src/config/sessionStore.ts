import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import type { Pool } from 'pg';

type Env = Record<string, string | undefined>;

/**
 * WHERE LOGIN SESSIONS LIVE.
 *
 * express-session's default MemoryStore keeps sessions in the process. That is
 * only correct while exactly one process serves every request - true of the
 * single-replica Kubera deployment, false on Vercel, where each request can land
 * on a different function instance and a session held in one instance's memory
 * is invisible to the next (the user is signed out at random).
 *
 * So Postgres holds them whenever the app runs on Vercel (`VERCEL` is set by the
 * platform in every build and function) or when SESSION_STORE=postgres opts in
 * elsewhere. Anything else keeps today's behaviour exactly: undefined here means
 * express-session falls back to MemoryStore.
 *
 * The table is created by db/migrate.ts (user_sessions), not by
 * connect-pg-simple's createTableIfMissing, which reads a .sql file off disk at
 * runtime that the function bundle would have to carry.
 */
export function usePostgresSessionStore(env: Env = process.env): boolean {
  return Boolean(env.VERCEL) || env.SESSION_STORE === 'postgres';
}

export function buildSessionStore(pool: Pool, env: Env = process.env): session.Store | undefined {
  if (!usePostgresSessionStore(env)) return undefined;

  const PgStore = connectPgSimple(session);
  return new PgStore({
    pool,
    tableName: 'user_sessions',
    createTableIfMissing: false,
  });
}
