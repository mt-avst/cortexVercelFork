import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { resolveDbTls as resolveTs } from '../dbTls';

/**
 * backend/scripts/db-tls.mjs is a hand-maintained ESM twin of dbTls.ts. It has
 * to be: firsthand-migrate.mjs is the deploy initContainer and runs as plain
 * node before any TypeScript build exists, so importing the compiled helper
 * would make the initContainer depend on dist/ - the kind of coupling that
 * turns a build change into a CrashLoop.
 *
 * Duplicating a security control is how drift starts, so this holds the two to
 * the same table. It drives the twin in a SUBPROCESS rather than importing it:
 * ts-jest compiles `await import()` to `require()` under CommonJS, which cannot
 * load an ES module, so an in-process import would fail for reasons that have
 * nothing to do with parity.
 */

const RDS = 'postgres://u:pw@cortex.abc123.eu-west-1.rds.amazonaws.com:5432/app';
const LOCAL = 'postgres://u:pw@localhost:5432/app';

const caDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-tls-parity-'));
const caPath = path.join(caDir, 'global-bundle.pem');
fs.writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nparity\n-----END CERTIFICATE-----\n');

type Env = Record<string, string | undefined>;

const CASES: Array<[string, Env]> = [
  [RDS, {}],
  [RDS, { DB_TLS_VERIFY: '1', DB_CA_BUNDLE: caPath }],
  [RDS, { DB_TLS_VERIFY: 'true', DB_CA_BUNDLE: caPath }],
  [RDS, { DB_TLS_VERIFY: '0' }],
  // The unverified path WITH overriding parameters. Without these the twins are
  // never compared on the description branch that names them, and a mutation
  // emptying that list in the .mjs survived.
  [`${RDS}?sslmode=disable`, {}],
  [`${RDS}?ssl=0`, {}],
  [`${RDS}?sslmode=verify-full&sslrootcert=/tmp/x.pem`, {}],
  [`${RDS}?sslmode=verify-full`, { DB_TLS_VERIFY: '1', DB_CA_BUNDLE: caPath }],
  [`${RDS}?ssl=0`, { DB_TLS_VERIFY: '1', DB_CA_BUNDLE: caPath }],
  [`${RDS}?sslmode=no-verify&application_name=x`, { DB_TLS_VERIFY: '1', DB_CA_BUNDLE: caPath }],
  [LOCAL, {}],
  [LOCAL, { DB_TLS_VERIFY: '1', DB_CA_BUNDLE: caPath }],
  ['postgres://u:pw@127.0.0.1:5432/app', {}],
  ['postgres://u:pw@postgres.default.svc.cluster.local:5432/app', {}],
  ['postgres://u:pw@ep-x.eu-central-1.aws.neon.tech:5432/app', {}],
  ['postgresql://postgres:password@postgres:5432/adaptalabs_dev', {}],
  ['postgresql://postgres:password@postgres-dev:5432/adaptalabs_dev', {}],
  ['not a url', {}],
  ['postgres://u:pw@/app?host=%2Fvar%2Frun%2Fpostgresql', {}],
  ['postgres://u:pw@/app?host=%2Fvar%2Frun%2Fpostgresql', { DB_TLS_VERIFY: '1' }],
  [`${LOCAL}?host=a&host=b`, {}],
  [`${RDS}?host=one.example.com`, {}],
  // Single-label under verification - the branch where the twins could differ
  // on the exemption rule.
  ['postgresql://postgres:password@postgres:5432/app', { DB_TLS_VERIFY: '1' }],
  ['postgresql://postgres:password@postgres:5432/app', { DB_TLS_VERIFY: '1', DB_TLS_LOCAL_HOSTS: 'postgres' }],
  ['postgresql://u:pw@localhost:5432/app', { DB_TLS_VERIFY: '1', DB_CA_BUNDLE: caPath }],
  // 'yes' is an accepted spelling and was never compared.
  [RDS, { DB_TLS_VERIFY: 'yes', DB_CA_BUNDLE: caPath }],
  // NO DB_CA_BUNDLE: this is the only case that exercises resolveCaPath and the
  // bundled-candidate lists, which necessarily differ between the twins because
  // .mjs has no __dirname. The guard whose job is catching divergence could not
  // see the most divergent part of the file.
  [RDS, { DB_TLS_VERIFY: '1' }],
];

function outcomeOfTs(url: string, env: Env) {
  try {
    return { threw: null, value: resolveTs(url, env) };
  } catch (error) {
    return { threw: error instanceof Error ? error.message : String(error), value: null };
  }
}

/** Runs every case through the .mjs twin in one subprocess. */
function outcomesOfMjs(cases: Array<[string, Env]>) {
  const mjs = path.resolve(__dirname, '../../../scripts/db-tls.mjs');
  const script = `
    import { resolveDbTls } from ${JSON.stringify(mjs)};
    const cases = JSON.parse(process.argv[1]);
    const out = cases.map(([url, env]) => {
      try { return { threw: null, value: resolveDbTls(url, env) }; }
      catch (error) { return { threw: error.message, value: null }; }
    });
    process.stdout.write(JSON.stringify(out));
  `;
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(cases)], {
    encoding: 'utf8',
  });
  return JSON.parse(stdout);
}

describe('dbTls.ts and db-tls.mjs agree', () => {
  const mjsResults = outcomesOfMjs(CASES);

  it.each(CASES.map((c, index) => [c[0], c[1], index] as const))(
    'agrees on %s',
    (url, env, index) => {
      const ts = outcomeOfTs(url, env);
      const mjs = mjsResults[index];
      expect(mjs.threw).toEqual(ts.threw);
      expect(mjs.value).toEqual(ts.value ? JSON.parse(JSON.stringify(ts.value)) : null);
    }
  );

  it('covers every mode, so parity is not agreement on one branch only', () => {
    const modes = new Set(
      CASES.map(([url, env]) => outcomeOfTs(url, env).value?.mode).filter(Boolean)
    );
    expect(modes).toEqual(new Set(['unverified', 'verified', 'disabled']));
  });
});
