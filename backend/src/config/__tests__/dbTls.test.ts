import fs from 'fs';
import os from 'os';
import path from 'path';
import { Client } from 'pg';

import { resolveDbTls, isVerificationRequested, resolveCaPath } from '../dbTls';

/**
 * These assert on the config pg WOULD CONNECT WITH, not on the object the
 * helper returns. pg merges a parsed connection string over the explicit ssl
 * option, so a helper can return a perfectly verifying config and the driver
 * can still connect in cleartext.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function effectiveSsl(result: { connectionString: string; ssl: unknown }): any {
  // connectionParameters is not on pg's public Client type, but it is the
  // resolved config that reaches tls.connect - which is the only thing worth
  // asserting on.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (new Client(result as any) as any).connectionParameters.ssl;
}

const RDS = 'postgres://u:pw@cortex.abc123.eu-west-1.rds.amazonaws.com:5432/app';
const LOCAL = 'postgres://u:pw@localhost:5432/app';

let caDir: string;
let caPath: string;
const CA_PEM = '-----BEGIN CERTIFICATE-----\nnot-a-real-ca\n-----END CERTIFICATE-----\n';

beforeAll(() => {
  caDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-tls-test-'));
  caPath = path.join(caDir, 'global-bundle.pem');
  fs.writeFileSync(caPath, CA_PEM);
});

describe('resolveDbTls with verification off (the shipped default)', () => {
  it('keeps the previous behaviour for a remote host, and says it is unverified', () => {
    const result = resolveDbTls(RDS, {});
    expect(result.mode).toBe('unverified');
    expect(result.ssl).toEqual({ rejectUnauthorized: false });
    expect(result.description).toMatch(/UNVERIFIED/);
    expect(result.description).toMatch(/DB_TLS_VERIFY=1/);
  });

  it('says when the connection string overrides it, rather than claiming TLS', () => {
    // The default path deliberately does NOT strip TLS parameters - stripping
    // would silently upgrade a deliberately-plaintext connection. So the string
    // still wins, and the log line is the only audit signal there is. It said
    // "UNVERIFIED TLS" over connections pg makes in cleartext.
    for (const [query, expected] of [
      ['?sslmode=disable', /sslmode=disable/],
      ['?ssl=0', /ssl=0/],
    ] as const) {
      const result = resolveDbTls(`${RDS}${query}`, {});
      expect(result.description).toMatch(expected);
      expect(result.description).toMatch(/OVER this setting/);
      expect(result.description).toMatch(/may be plaintext/);
      // And the claim is true: pg really does connect in cleartext here.
      expect(effectiveSsl(result)).toBe(false);
    }
  });

  it('does not cry override when there is none', () => {
    expect(resolveDbTls(RDS, {}).description).not.toMatch(/OVER this setting/);
  });

  it('judges the host pg will actually use when one is duplicated', () => {
    // Returning no TLS here was a DOWNGRADE on the code being replaced: the old
    // pool encrypted, so a duplicated host would have gone from encrypted to
    // cleartext against a remote server.
    const result = resolveDbTls(
      'postgres://u:pw@x:5432/app?host=localhost&host=cortex.abc.eu-west-1.rds.amazonaws.com',
      {}
    );
    expect(result.ssl).not.toBe(false);
    expect(result.mode).toBe('unverified');
  });

  it('never throws, whatever it is handed', () => {
    for (const url of ['not a url', `${RDS}?host=a&host=b`, LOCAL, RDS]) {
      expect(() => resolveDbTls(url, {})).not.toThrow();
    }
  });

  it('does not describe the connection string or its password', () => {
    const result = resolveDbTls('postgres://u:hunter2@db.example.com:5432/app', {});
    expect(result.description).not.toMatch(/hunter2/);
  });

  it('applies no TLS to a local host', () => {
    expect(resolveDbTls(LOCAL, {}).ssl).toBe(false);
    expect(resolveDbTls('postgres://u:pw@127.0.0.1:5432/app', {}).ssl).toBe(false);
  });

  it('treats this project\'s docker-compose database hosts as local', () => {
    // docker-compose.yml and docker-compose.dev.yml reach postgres at these
    // bare service names. They are plaintext containers, so attempting TLS
    // would break local development outright - and they got no TLS under the
    // previous code either, so this keeps them identical.
    for (const host of ['postgres', 'postgres-dev', 'db']) {
      const result = resolveDbTls(`postgresql://postgres:password@${host}:5432/adaptalabs_dev`, {});
      expect(result.ssl).toBe(false);
      expect(result.mode).toBe('disabled');
    }
  });

  it('still treats a dotted remote host as remote', () => {
    expect(resolveDbTls('postgres://u:pw@db.example.com:5432/app', {}).ssl).not.toBe(false);
  });

  it('decides from the host, not from NODE_ENV', () => {
    // The old application pool used `NODE_ENV === 'production' ? {...} : false`,
    // so a remote database reached with NODE_ENV unset got NO TLS at all.
    for (const NODE_ENV of [undefined, 'development', 'test', 'production']) {
      const result = resolveDbTls(RDS, NODE_ENV ? { NODE_ENV } : {});
      expect(result.ssl).not.toBe(false);
    }
  });
});

describe('resolveDbTls with DB_TLS_VERIFY set', () => {
  it('verifies against the supplied CA, and pg would use it', () => {
    const result = resolveDbTls(RDS, { DB_TLS_VERIFY: '1', DB_CA_BUNDLE: caPath });
    expect(result.mode).toBe('verified');
    const ssl = effectiveSsl(result);
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.ca).toBe(CA_PEM);
  });

  it('strips TLS parameters so the connection string cannot override the decision', () => {
    const result = resolveDbTls(
      `${RDS}?sslmode=verify-full&ssl=0&application_name=x`,
      { DB_TLS_VERIFY: '1', DB_CA_BUNDLE: caPath }
    );
    const params = new URL(result.connectionString).searchParams;
    expect(params.has('sslmode')).toBe(false);
    expect(params.has('ssl')).toBe(false);
    expect(params.get('application_name')).toBe('x');
    // The property that matters: what pg ends up with.
    const ssl = effectiveSsl(result);
    expect(ssl).not.toBe(false);
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.ca).toBe(CA_PEM);
  });

  it('refuses rather than connecting when no CA can be found, and says what to do', () => {
    // This fires on a CrashLoop or a failed start, where nobody is watching a
    // terminal, so a bare ENOENT is not enough - the message carries the remedy.
    let message = '';
    try {
      resolveDbTls(RDS, { DB_TLS_VERIFY: '1', DB_CA_BUNDLE: '/nonexistent/ca.pem' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/\/nonexistent\/ca\.pem/);
    expect(message).toMatch(/ENOENT|no such file/i);
    expect(message).toMatch(/DB_CA_BUNDLE/);
    expect(message).toMatch(/unset DB_TLS_VERIFY/);
  });

  it('refuses an ambiguous duplicated host rather than judging the wrong server', () => {
    expect(() =>
      resolveDbTls(`${LOCAL}?host=localhost&host=elsewhere.example.com`, {
        DB_TLS_VERIFY: '1',
        DB_CA_BUNDLE: caPath,
      })
    ).toThrow(/host more than once/);
  });

  it('refuses an unparseable connection string rather than guessing', () => {
    expect(() => resolveDbTls('not a url', { DB_TLS_VERIFY: '1' })).toThrow(/could not be parsed/);
  });

  it('does not refuse a unix socket, which is local by definition', () => {
    // `new URL` rejects the empty authority in this form while pg accepts it,
    // so it lands in the unparseable branch. Refusing it under DB_TLS_VERIFY
    // would contradict the socket handling and stop the process for a
    // connection that never leaves the machine.
    for (const url of [
      'postgres://u:pw@/app?host=%2Fvar%2Frun%2Fpostgresql',
      'postgres://u:pw@/app?host=/var/run/postgresql',
    ]) {
      const result = resolveDbTls(url, { DB_TLS_VERIFY: '1', DB_CA_BUNDLE: caPath });
      expect(result.ssl).toBe(false);
      expect(result.mode).toBe('disabled');
    }
  });

  it('still applies no TLS to a genuinely local host', () => {
    expect(resolveDbTls(LOCAL, { DB_TLS_VERIFY: '1', DB_CA_BUNDLE: caPath }).ssl).toBe(false);
  });

  it('rejects an empty CA file, which would silently trust the public roots', () => {
    const empty = path.join(caDir, 'empty.pem');
    fs.writeFileSync(empty, '');
    expect(() => resolveDbTls(RDS, { DB_TLS_VERIFY: '1', DB_CA_BUNDLE: empty })).toThrow(
      /no certificate/i
    );
  });
});

describe('the single-label exemption stops at DB_TLS_VERIFY', () => {
  // The exemption exists for docker-compose, where nobody sets DB_TLS_VERIFY.
  // A single-label name resolved through a DNS search suffix is a REMOTE host,
  // so exempting it while verification is switched on would hand an operator
  // plaintext plus an informational log line, having told them TLS was verified.
  it('exempts a bare service name while verification is off', () => {
    const result = resolveDbTls('postgresql://postgres:password@postgres:5432/app', {});
    expect(result.ssl).toBe(false);
    expect(result.mode).toBe('disabled');
  });

  it('stops exempting it once verification is requested', () => {
    const result = resolveDbTls('postgresql://postgres:password@postgres:5432/app', {
      DB_TLS_VERIFY: '1',
      DB_CA_BUNDLE: caPath,
    });
    expect(result.mode).toBe('verified');
    expect(effectiveSsl(result).rejectUnauthorized).toBe(true);
  });

  it('lets an operator name genuinely local bare hosts explicitly', () => {
    const result = resolveDbTls('postgresql://postgres:password@postgres:5432/app', {
      DB_TLS_VERIFY: '1',
      DB_CA_BUNDLE: caPath,
      DB_TLS_LOCAL_HOSTS: 'other, postgres ,another',
    });
    expect(result.ssl).toBe(false);
  });

  it('says so LOUDLY when the allow-list is what exempted a host', () => {
    // Plain DB_TLS_VERIFY=0 warns. Without this, an allow-listed exemption
    // produced a quiet info-level "local host" line indistinguishable from a
    // genuine loopback exemption, and passed any audit keyed on "is
    // DB_TLS_VERIFY set to 1" - a loud downgrade turned into a silent one.
    const result = resolveDbTls('postgresql://postgres:password@postgres:5432/app', {
      DB_TLS_VERIFY: '1',
      DB_CA_BUNDLE: caPath,
      DB_TLS_LOCAL_HOSTS: 'postgres',
    });
    expect(result.mode).toBe('unverified');
    expect(result.description).toMatch(/DB_TLS_LOCAL_HOSTS/);
    expect(result.description).toMatch(/NO TLS/);
    expect(result.description).toMatch(/despite DB_TLS_VERIFY=1/);
  });

  it('does not shout about a genuine loopback exemption', () => {
    const result = resolveDbTls('postgresql://u:pw@localhost:5432/app', {
      DB_TLS_VERIFY: '1',
      DB_CA_BUNDLE: caPath,
    });
    expect(result.mode).toBe('disabled');
    expect(result.description).toMatch(/local host/);
    expect(result.description).not.toMatch(/DB_TLS_LOCAL_HOSTS/);
  });

  it('does not let the allow-list cover a host it does not name', () => {
    const result = resolveDbTls('postgresql://postgres:password@elsewhere:5432/app', {
      DB_TLS_VERIFY: '1',
      DB_CA_BUNDLE: caPath,
      DB_TLS_LOCAL_HOSTS: 'postgres',
    });
    expect(result.mode).toBe('verified');
  });

  it('still exempts real loopback names with verification on', () => {
    for (const host of ['localhost', '127.0.0.1', 'postgres.default.svc.cluster.local']) {
      const result = resolveDbTls(`postgresql://u:pw@${host}:5432/app`, {
        DB_TLS_VERIFY: '1',
        DB_CA_BUNDLE: caPath,
      });
      expect(result.ssl).toBe(false);
    }
  });
});

describe('the switch itself', () => {
  it('is off unless explicitly set', () => {
    for (const env of [{}, { DB_TLS_VERIFY: '' }, { DB_TLS_VERIFY: '0' }, { DB_TLS_VERIFY: 'no' }]) {
      expect(isVerificationRequested(env)).toBe(false);
    }
  });

  it('accepts the spellings an operator is likely to use', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', ' 1 ']) {
      expect(isVerificationRequested({ DB_TLS_VERIFY: value })).toBe(true);
    }
  });
});

describe('the bundled CA', () => {
  it('is committed, is a real certificate bundle, and is found without configuration', () => {
    const bundled = resolveCaPath({});
    expect(bundled).toBeTruthy();
    const pem = fs.readFileSync(bundled as string, 'utf8');
    expect(pem).toMatch(/-----BEGIN CERTIFICATE-----/);
    // The whole point of shipping it: RDS roots are private, so Node cannot
    // verify RDS without them. A bundle that lost the RDS roots would verify
    // nothing useful.
    expect(pem.match(/-----BEGIN CERTIFICATE-----/g)!.length).toBeGreaterThan(50);
  });

  it('prefers an explicitly configured path over the bundled one', () => {
    expect(resolveCaPath({ DB_CA_BUNDLE: '/tmp/explicit.pem' })).toBe('/tmp/explicit.pem');
    expect(resolveCaPath({ PGSSLROOTCERT: '/tmp/libpq.pem' })).toBe('/tmp/libpq.pem');
  });
});
