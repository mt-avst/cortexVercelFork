import { describe, it, expect, jest, afterEach } from '@jest/globals';
import http from 'node:http';
import express from 'express';

// #153. The app assembly (index.ts) must bind NO socket when imported, under any
// NODE_ENV. listen used to run at module scope in index.ts, guarded only by
// `NODE_ENV !== 'test'`; a helper that re-imports the entrypoint under
// NODE_ENV=development (to read dev-only route registration) therefore bound the
// real PORT, and failed `authorisation-inventory` by name whenever anything else
// held that port - a dev backend, another worktree, a stale process. The listen
// now lives in server.ts, which nothing but the process start imports.
//
// The pool is doubled so importing the whole route graph needs no database, the
// same shape authorisation-inventory.test.ts uses for its isolateModules import.
jest.mock('../config', () => ({
  ...(jest.requireActual('../config') as object),
  pool: { query: jest.fn(), connect: jest.fn() },
}));
jest.mock('../utils/database', () => ({ isDatabaseAvailable: jest.fn() }));

describe('the app assembly binds no socket on import (#153)', () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    jest.restoreAllMocks();
  });

  it('importing ../index under NODE_ENV=development calls listen zero times', () => {
    const listenSpy = jest.spyOn(http.Server.prototype, 'listen');
    // The exact value that used to trigger the module-scope bind. (The failing
    // helper also set PORT=0 hoping for an ephemeral port; that is a separate
    // config-validation bug and irrelevant now the listen has left this module.)
    process.env.NODE_ENV = 'development';

    jest.isolateModules(() => {
      // node-cron no longer imported by index; mock it anyway so a regression
      // that moves a schedule back into the assembly cannot leave a live timer
      // running behind this assertion.
      jest.doMock('node-cron', () => ({
        __esModule: true,
        default: { schedule: () => undefined },
      }));
      require('../index');
    });

    expect(listenSpy).not.toHaveBeenCalled();
  });

  // Control: the absence-assertion above is only worth anything if the spy can
  // still see a real listen. A raw express app proves it. Bound to 127.0.0.1
  // explicitly, not the bare `listen(0)` wildcard the #44 reservoir forbids.
  it('control: the listen spy detects a real listen', async () => {
    const listenSpy = jest.spyOn(http.Server.prototype, 'listen');
    const server = express().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(listenSpy).toHaveBeenCalled();
  });
});
