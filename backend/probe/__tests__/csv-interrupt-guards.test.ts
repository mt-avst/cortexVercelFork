/**
 * The two guards on backend/probe/csv-interrupt.ts.
 *
 * They are the only thing standing between a seeding script and somebody's
 * real database, and between an admin session cookie and a host somebody else
 * controls. Both had a hole that a hand-check would never find, and both holes
 * are pinned below by the exact string that opened them.
 *
 * EVERY REFUSAL HAS AN ACCEPTANCE BESIDE IT. A guard that refuses everything
 * passes every refusal test there is, and would take the probe with it.
 */
import { assertProbeTargetSafe, assertSeedTargetSafe } from '../csv-interrupt';

const LOOPBACK_DB = 'postgres://postgres:postgres@localhost:5432/adaptalabs_dev';

describe('assertSeedTargetSafe', () => {
  it('accepts the loopback scratch database it is meant for', () => {
    expect(assertSeedTargetSafe(LOOPBACK_DB, null)).toBe('adaptalabs_dev');
  });

  it('refuses an IPv6 loopback literal rather than admitting one that cannot connect', () => {
    // NOT an oversight, and the previous version of this test asserted the
    // opposite. `pg-connection-string` parses `postgres://u:p@[::1]:5432/db` to
    // host `"[::1]"`, brackets kept, and neither `pg` nor `net.connect` will
    // dial that string: both give `ENOTFOUND [::1]`, name resolution failing on
    // a literal. So the guard used to say yes and the command then died. A
    // guard that admits something which cannot work is worse than one that
    // refuses it, because the operator debugs the wrong thing. `localhost`
    // still reaches IPv6 loopback wherever the resolver prefers it.
    expect(() => assertSeedTargetSafe('postgres://u:p@[::1]:5432/firsthand_test', null)).toThrow(
      /loopback/
    );
  });

  it('refuses a connection string that smuggles a host query parameter', () => {
    // THE HOLE. `pg-connection-string`, which `pg.Pool({connectionString})`
    // parses with, honours `?host=` OVER the authority in the URL - measured:
    // `postgres://u:x@localhost:5432/db?host=192.168.1.130` parses to host
    // 192.168.1.130. So a guard reading `new URL(...).hostname` saw
    // "localhost", passed, and pg then dialled the remote address for real.
    // That is precisely the port-forward-to-production case the loopback rule
    // exists to stop, and `clean` issues DELETEs through the same guard.
    expect(() =>
      assertSeedTargetSafe(`${LOOPBACK_DB}?host=192.168.1.130`, null)
    ).toThrow(/"host" query parameter/);
  });

  it('refuses a connection string that smuggles a port query parameter', () => {
    // Same override, same parser, different socket. Measured: `?port=9999`
    // parses to port 9999 whatever the authority says.
    expect(() => assertSeedTargetSafe(`${LOOPBACK_DB}?port=9999`, null)).toThrow(
      /"port" query parameter/
    );
  });

  it('refuses a connection string that smuggles a hostaddr query parameter', () => {
    // LATENT, NOT LIVE, and pinned anyway. A review gate measured that
    // node-postgres parses `hostaddr` into the config and then never dials it:
    // an unroutable TEST-NET address in `hostaddr` still reached the local
    // container. libpq, whose syntax this imitates, DOES connect to it. So this
    // is one npm release away from being the same bypass as `host`, in a file
    // nobody will re-audit for it.
    expect(() => assertSeedTargetSafe(`${LOOPBACK_DB}?hostaddr=10.0.0.5`, null)).toThrow(
      /"hostaddr" query parameter/
    );
  });

  it('refuses a percent-encoded spelling of a smuggling parameter', () => {
    // `?%68ost=` is `?host=`, and `pg-connection-string` DOES decode and
    // redirect on it. This guard reads the decoded keys `searchParams` hands
    // it, so its view is a superset of the parser's redirect surface rather
    // than a guess at which spellings the parser accepts. Pinned because a
    // future rewrite reaching for a raw-string `includes('host=')` would pass
    // every other test in this file and reopen the hole.
    expect(() => assertSeedTargetSafe(`${LOOPBACK_DB}?%68ost=192.168.1.130`, null)).toThrow(
      /"host" query parameter/
    );
  });

  it('refuses those parameters whatever their case', () => {
    // `?HOST=` does NOT override in the installed pg-connection-string, so this
    // is defence in depth against a parser that starts folding case, not a
    // live defect. Named as what it is rather than left to look like a bug fix.
    expect(() => assertSeedTargetSafe(`${LOOPBACK_DB}?HOST=evil.example`, null)).toThrow(
      /"HOST" query parameter/
    );
  });

  it('leaves a query string carrying neither parameter alone', () => {
    // THE CONTROL for the three above. Without it, a guard that refused every
    // query string at all would pass them and quietly break sslmode and
    // application_name, which are the parameters people legitimately use.
    expect(
      assertSeedTargetSafe(`${LOOPBACK_DB}?sslmode=disable&application_name=probe`, null)
    ).toBe('adaptalabs_dev');
  });

  it('refuses a non-loopback host', () => {
    expect(() =>
      assertSeedTargetSafe('postgres://u:p@10.0.0.5:5432/adaptalabs_dev', null)
    ).toThrow(/loopback/);
  });

  it('refuses a host that merely ends in something loopback-looking', () => {
    expect(() =>
      assertSeedTargetSafe('postgres://u:p@127.0.0.1.evil.example:5432/adaptalabs_dev', null)
    ).toThrow(/loopback/);
  });

  it('refuses a production-looking database name', () => {
    expect(() =>
      assertSeedTargetSafe('postgres://u:p@localhost:5432/adaptalabs_production', null)
    ).toThrow(/adaptalabs_production/);
  });

  it('refuses an unlisted database name, and names the escape hatch', () => {
    expect(() =>
      assertSeedTargetSafe('postgres://u:p@localhost:5432/somethingelse', null)
    ).toThrow(/--confirm-db somethingelse/);
  });

  it('accepts an unlisted name only when it is confirmed by name', () => {
    expect(
      assertSeedTargetSafe('postgres://u:p@localhost:5432/somethingelse', 'somethingelse')
    ).toBe('somethingelse');
    // And confirming the WRONG name does not help, or `--confirm-db` would be
    // a switch that turns the allowlist off rather than a statement of intent.
    expect(() =>
      assertSeedTargetSafe('postgres://u:p@localhost:5432/somethingelse', 'other')
    ).toThrow(/Refusing to seed "somethingelse"/);
  });
});

describe('assertProbeTargetSafe', () => {
  it('accepts the real playground host', () => {
    expect(
      assertProbeTargetSafe('https://adaptalabs.kubera-playground.adaptavist.net').hostname
    ).toBe('adaptalabs.kubera-playground.adaptavist.net');
  });

  it('accepts localhost', () => {
    expect(assertProbeTargetSafe('http://localhost:5000').port).toBe('5000');
  });

  it('refuses a host that merely contains the playground name', () => {
    // THE HOLE. `host.includes('kubera-playground')` admitted this, and the
    // probe then sent the operator's `adaptalabs_session` cookie to it - a live
    // admin credential handed to an attacker-chosen host by a guard written to
    // protect data. A suffix match is the fix.
    expect(() => assertProbeTargetSafe('https://kubera-playground.evil.example')).toThrow(
      /Refusing to probe/
    );
  });

  it('refuses a host that only prefixes the playground suffix without a dot', () => {
    // `endsWith('.kubera-playground.adaptavist.net')` rather than
    // `endsWith('kubera-playground.adaptavist.net')`: the second admits
    // `evilkubera-playground.adaptavist.net`, a registerable name.
    expect(() =>
      assertProbeTargetSafe('https://evilkubera-playground.adaptavist.net')
    ).toThrow(/Refusing to probe/);
  });

  it('refuses a userinfo trick that puts the permitted host before an @', () => {
    expect(() => assertProbeTargetSafe('http://localhost@evil.example/')).toThrow(
      /Refusing to probe/
    );
  });

  it('refuses an unrelated host', () => {
    expect(() => assertProbeTargetSafe('https://adaptalabs.example.com')).toThrow(
      /Refusing to probe/
    );
  });

  it('refuses something that is not a URL at all', () => {
    expect(() => assertProbeTargetSafe('not a url')).toThrow(/not a URL/);
  });
});
