import { applyDbTls, getAppliedDbTlsModes, resolveDbTls } from '../dbTls';

/**
 * `DB_TLS_VERIFY` went live in 7.36.3 and its only evidence was a line on the
 * pod's stdout, so confirming it did anything needed cluster access - and a
 * flag that shipped inert would have looked identical to one that worked.
 * These pin the report that replaces that log line.
 */
describe('applied DB TLS modes', () => {
  const URL = 'postgres://u:p@db.example.com:5432/app';

  // Against resolveDbTls rather than a hardcoded string. The property that
  // matters is that the report says what the pool DECIDED - pinning a literal
  // here would only re-state which mode this particular env produces, and my
  // first attempt got that wrong ('0' means unverified, not disabled).
  it('records what the pool actually resolved, keyed by its label', () => {
    const env = { DB_TLS_VERIFY: '0' };
    applyDbTls(URL, env, 'probe-one');

    expect(getAppliedDbTlsModes()['probe-one']).toBe(resolveDbTls(URL, env).mode);
  });

  it('records each pool separately, so one cannot mask another', () => {
    applyDbTls(URL, { DB_TLS_VERIFY: '0' }, 'probe-a');
    applyDbTls('postgres://u:p@other.example.com:5432/app?sslmode=disable', {}, 'probe-b');

    const modes = getAppliedDbTlsModes();
    // Distinct inputs, so a report that recorded one pool under both labels -
    // or overwrote the first - is visible.
    expect(Object.keys(modes)).toEqual(expect.arrayContaining(['probe-a', 'probe-b']));
    expect(modes['probe-a']).toBe(resolveDbTls(URL, { DB_TLS_VERIFY: '0' }).mode);
  });

  it('reports a pool that has never resolved as absent, not as a pass', () => {
    // Absence is the honest answer for the FirstHand runtime pool, which
    // connects lazily and so is missing until something uses it.
    expect(getAppliedDbTlsModes()['a-pool-that-never-connected']).toBeUndefined();
  });

  it('carries the mode alone, never the host or the CA path', () => {
    applyDbTls(URL, { DB_TLS_VERIFY: '0' }, 'probe-leak');

    // `description` names the database host and the bundle path. Neither is
    // needed to answer "is verification on", and this report is read over HTTP.
    const serialised = JSON.stringify(getAppliedDbTlsModes());
    expect(serialised).not.toContain('db.example.com');
    expect(serialised).not.toContain('/');
  });
});
