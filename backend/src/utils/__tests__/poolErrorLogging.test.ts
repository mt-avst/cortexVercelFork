import { EventEmitter } from 'events';
import type { Pool, PoolClient } from 'pg';
import { attachPoolErrorLogging } from '../../utils/poolErrorLogging';
import { logger } from '../../utils/logger';

/**
 * A pg Pool and a pg Client are both EventEmitters, and the behaviour under
 * test is EventEmitter behaviour: emitting `error` with no listener throws.
 * Bare emitters are therefore faithful stand-ins and keep the test off a real
 * database. The listener-swap sequencing these fakes model was verified
 * against the real pg-pool source and reproduced against postgres:17.
 */
function createFakePool(): Pool {
  return new EventEmitter() as unknown as Pool;
}

function createFakeClient(): PoolClient {
  return new EventEmitter() as unknown as PoolClient;
}

describe('attachPoolErrorLogging', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  describe('idle clients', () => {
    it('is required: an unguarded pool throws when an idle client errors', () => {
      const unguarded = createFakePool();

      // The production crash path. Node throws on an `error` event with no
      // listener, which on a single-replica backend is a full outage.
      expect(() => unguarded.emit('error', new Error('connection terminated'))).toThrow(
        'connection terminated'
      );
    });

    it('survives the idle-client error once attached', () => {
      const pool = attachPoolErrorLogging(createFakePool(), 'backend');

      expect(() => pool.emit('error', new Error('connection terminated'))).not.toThrow();
    });

    it('survives a burst rather than only the first failure', () => {
      const pool = attachPoolErrorLogging(createFakePool(), 'backend');

      // A failover drops every idle connection at once.
      for (let i = 0; i < 5; i += 1) {
        expect(() => pool.emit('error', new Error(`drop ${i}`))).not.toThrow();
      }

      expect(errorSpy).toHaveBeenCalledTimes(5);
    });
  });

  describe('checked-out clients', () => {
    it('is required: a checked-out client has no listener of its own', () => {
      // pg-pool removes its idle listener on checkout and only restores it on
      // release, so a client checked out but not mid-query is unguarded. This
      // is the path a Pool-only listener cannot see, and it was reproduced
      // against a real postgres before this guard was written.
      const bareClient = createFakeClient();

      expect(() => bareClient.emit('error', new Error('admin shutdown'))).toThrow(
        'admin shutdown'
      );
    });

    it('guards a client from the moment it is acquired', () => {
      const pool = attachPoolErrorLogging(createFakePool(), 'backend');
      const client = createFakeClient();

      pool.emit('acquire', client);

      expect(() => client.emit('error', new Error('admin shutdown'))).not.toThrow();
      expect(errorSpy).toHaveBeenCalledWith(
        'Unexpected error on checked-out database client',
        expect.objectContaining({ poolName: 'backend' })
      );
    });

    it('stops guarding on release, so idle errors are not logged twice', () => {
      const pool = attachPoolErrorLogging(createFakePool(), 'backend');
      const client = createFakeClient();

      pool.emit('acquire', client);
      // Asserted before the release too, so this cannot pass vacuously against
      // an implementation that never attached anything in the first place.
      expect((client as unknown as EventEmitter).listenerCount('error')).toBe(1);

      pool.emit('release', undefined, client);

      // pg-pool has re-attached its own idle listener by this point, so ours
      // must come off or every idle error produces two log lines.
      expect((client as unknown as EventEmitter).listenerCount('error')).toBe(0);
    });

    it('re-guards across repeated checkout cycles', () => {
      const pool = attachPoolErrorLogging(createFakePool(), 'backend');
      const client = createFakeClient();

      for (let i = 0; i < 3; i += 1) {
        pool.emit('acquire', client);
        expect(() => client.emit('error', new Error(`cycle ${i}`))).not.toThrow();
        pool.emit('release', undefined, client);
      }

      expect(errorSpy).toHaveBeenCalledTimes(3);
      expect((client as unknown as EventEmitter).listenerCount('error')).toBe(0);
    });
  });

  describe('log context', () => {
    it('never serialises the pg client, which carries connection details', () => {
      const pool = attachPoolErrorLogging(createFakePool(), 'backend');
      const error = new Error('terminating connection due to administrator command');

      // pg-pool sets err.client before emitting. Serialising it writes the DB
      // user, database, host, port and the backend cancel key into logs.
      (error as Error & { client?: unknown }).client = {
        connectionParameters: {
          user: 'cortex_app',
          database: 'adaptalabs',
          host: 'cortex-prod.example.rds.amazonaws.com',
        },
        secretKey: 123456,
      };

      pool.emit('error', error);

      const [, context] = errorSpy.mock.calls[0];
      expect(context).not.toHaveProperty('error');
      expect(JSON.stringify(context)).not.toContain('cortex_app');
      expect(JSON.stringify(context)).not.toContain('rds.amazonaws.com');
      expect(JSON.stringify(context)).not.toContain('123456');
    });

    it('keeps the diagnostics that matter, including the failover code', () => {
      const pool = attachPoolErrorLogging(createFakePool(), 'firsthand-runtime');
      const error = Object.assign(
        new Error('terminating connection due to administrator command'),
        { code: '57P01' }
      );

      pool.emit('error', error);

      expect(errorSpy).toHaveBeenCalledWith('Unexpected error on idle database client', {
        poolName: 'firsthand-runtime',
        errorMessage: 'terminating connection due to administrator command',
        errorDetails: {
          name: 'Error',
          code: '57P01',
          stack: error.stack,
        },
      });
    });

    it('tolerates a non-Error payload without throwing', () => {
      const pool = attachPoolErrorLogging(createFakePool(), 'backend');

      expect(() => pool.emit('error', undefined as unknown as Error)).not.toThrow();
      expect(errorSpy).toHaveBeenCalledWith(
        'Unexpected error on idle database client',
        expect.objectContaining({ poolName: 'backend' })
      );
    });
  });

  describe('idempotency', () => {
    it('does not stack duplicate listeners when attached twice', () => {
      const pool = createFakePool();

      attachPoolErrorLogging(pool, 'backend');
      attachPoolErrorLogging(pool, 'backend');

      expect((pool as unknown as EventEmitter).listenerCount('error')).toBe(1);
      expect((pool as unknown as EventEmitter).listenerCount('acquire')).toBe(1);
      expect((pool as unknown as EventEmitter).listenerCount('release')).toBe(1);
    });

    it('returns the same pool instance so it can wrap a constructor call', () => {
      const pool = createFakePool();

      expect(attachPoolErrorLogging(pool, 'backend')).toBe(pool);
    });
  });
});
