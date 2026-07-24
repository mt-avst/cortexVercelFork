import { EventEmitter } from 'events';
import { pool } from '../../config';

/**
 * The exported backend pool serves all Express traffic, and without these
 * listeners a dropped connection terminates the process. The helper's own
 * unit tests cannot catch it being unwired here: removing the
 * attachPoolErrorLogging call from config/index.ts left every other suite
 * green, so this pins the wiring itself rather than the helper's behaviour.
 */
describe('backend pool error guards', () => {
  it('registers an error listener, so an idle-client error cannot kill the process', () => {
    expect((pool as unknown as EventEmitter).listenerCount('error')).toBe(1);
  });

  it('registers acquire and release listeners that guard checked-out clients', () => {
    // pg-pool strips a client's own error listener while it is checked out, so
    // the Pool listener above does not cover a client held across a
    // transaction. That gap is closed by this pair.
    expect((pool as unknown as EventEmitter).listenerCount('acquire')).toBe(1);
    expect((pool as unknown as EventEmitter).listenerCount('release')).toBe(1);
  });
});
