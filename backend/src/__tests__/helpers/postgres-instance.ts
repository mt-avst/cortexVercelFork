import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";

import pg from "pg";

const execFileAsync = promisify(execFile);

/**
 * A real Postgres for the tests that need one, from whichever source is
 * available.
 *
 * THREE FILES HAD A COPY OF THIS, character for character apart from the
 * container name, and every one of them could only get a database by starting
 * a container. That is why none of them ran in CI: the runners are tagged
 * `no-docker`, so `docker info` fails and the only honest thing left was to
 * skip. The cost of that skip was not evenly spread - one of the three is the
 * only place the survey CSV export's tenant-isolation predicate is evaluated
 * at all, so the check that a study's results cannot cross an opportunity
 * boundary existed exclusively on developer machines.
 *
 * So the source is now a choice rather than an assumption. Set
 * FIRSTHAND_TEST_DATABASE_URL and these files use that server; leave it unset
 * and they start their own container exactly as before. A GitLab `services:`
 * entry supplies the first without needing a Docker daemon inside the job,
 * which is the distinction that makes CI coverage possible at all.
 *
 * DELIBERATELY NOT `DATABASE_URL`. The .test-base job blanks DATABASE_URL,
 * POSTGRES_URL, POSTGRESQL_URL and DB_URL together, because with any of them
 * set race-condition.test.ts opens a real connection and fails against a
 * schema that does not exist there. Reusing one of those names to solve this
 * problem would reintroduce that one. A separate name is inert to every test
 * that does not ask for it.
 */
export interface TestPostgres {
  /** Points at a database owned solely by this caller. */
  connectionString: string;
  /** Drops the database, or removes the container. Never throws. */
  stop: () => Promise<void>;
}

const SUPPLIED_URL = "FIRSTHAND_TEST_DATABASE_URL";
const SKIP_FLAG = "FIRSTHAND_SKIP_DB_TESTS";

/**
 * Refuses the one combination that would quietly undo the CI job.
 *
 * `FIRSTHAND_SKIP_DB_TESTS=1` makes these files `describe.skipIf` themselves,
 * which is correct where there is no database and catastrophic where there is:
 * `test-backend-db` would report `3 skipped, 16 skipped` and exit 0, a green
 * job having checked nothing. That job exists precisely because a skipped
 * suite read as a pass for months, and the skip flag is set forty lines above
 * it in the same file, in the sibling job - one copy-paste away.
 *
 * Supplying a server and asking to skip is not a configuration, it is a
 * mistake, so it fails loudly instead. Called from module scope, not from a
 * test body, so it fires even though every describe is being skipped.
 */
function refuseSkippingWithAServer(): void {
  if (process.env[SUPPLIED_URL] && process.env[SKIP_FLAG] === "1") {
    throw new Error(
      `${SUPPLIED_URL} and ${SKIP_FLAG}=1 are both set. A database was ` +
        "supplied and the tests that need it were told to skip, which would " +
        "report a green run having evaluated nothing. Unset one of them."
    );
  }
}

refuseSkippingWithAServer();

/**
 * A database per caller, even when the server is shared.
 *
 * All three files migrate into the same `firsthand` schema and TRUNCATE it
 * between tests, and vitest runs files in parallel. Pointed at one shared
 * database they would truncate each other's fixtures mid-test - a flake that
 * only appears under the very configuration CI would use, which is the worst
 * possible place to discover it. Each caller therefore gets its own database
 * on the shared server.
 */
function uniqueDatabaseName(label: string): string {
  const safe = label.replace(/[^a-z0-9]+/gi, "_").toLowerCase().slice(0, 20);
  return `fh_test_${safe}_${process.pid}_${randomBytes(4).toString("hex")}`;
}

async function waitForPostgres(connectionString: string): Promise<void> {
  // A real connection, not `pg_isready` - the image runs a temporary server on
  // a unix socket while initdb finishes, so pg_isready reports ready and the
  // client that trusts it gets "Connection terminated unexpectedly".
  const deadline = Date.now() + 60_000;
  for (;;) {
    const client = new pg.Client({ connectionString, connectionTimeoutMillis: 2_000 });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch (error) {
      await client.end().catch(() => {});
      if (Date.now() > deadline) {
        throw new Error(
          `Postgres did not accept a connection within 60s: ${String(error)}`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

async function useSuppliedServer(
  suppliedUrl: string,
  label: string
): Promise<TestPostgres> {
  await waitForPostgres(suppliedUrl);

  const database = uniqueDatabaseName(label);
  const admin = new pg.Client({ connectionString: suppliedUrl });
  await admin.connect();
  try {
    // Identifier, so it cannot be a bound parameter. `uniqueDatabaseName`
    // strips everything outside [a-z0-9_] and the label is a literal at every
    // call site, but the quoting stays because the next call site might not be.
    await admin.query(`CREATE DATABASE "${database}"`);
  } finally {
    await admin.end().catch(() => {});
  }

  const url = new URL(suppliedUrl);
  url.pathname = `/${database}`;
  const connectionString = url.toString();

  return {
    connectionString,
    stop: async () => {
      const cleanup = new pg.Client({ connectionString: suppliedUrl });
      try {
        await cleanup.connect();
        await cleanup.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      } catch {
        // A leaked database on a throwaway CI service is not worth failing a
        // green run over. The server goes when the job does.
      } finally {
        await cleanup.end().catch(() => {});
      }
    }
  };
}

async function startOwnContainer(label: string): Promise<TestPostgres> {
  try {
    await execFileAsync("docker", ["info"], { timeout: 10_000 });
  } catch {
    throw new Error(
      `Docker is required for ${label} (a real Postgres, so that constraints, ` +
        "predicates, parameters and ordering are actually evaluated rather " +
        `than mocked away). Start Docker, supply ${SUPPLIED_URL} to use a ` +
        "server you already have, or set FIRSTHAND_SKIP_DB_TESTS=1 to opt out."
    );
  }

  // Random per run rather than a literal in the repo: a vitest process killed
  // with SIGKILL never runs afterAll, leaving the container up.
  const password = randomBytes(16).toString("hex");
  const containerName = `firsthand-${label.replace(/[^a-z0-9]+/gi, "-")}-pg-${process.pid}`;

  await execFileAsync("docker", [
    "run", "-d", "--rm", "--name", containerName,
    "-e", `POSTGRES_PASSWORD=${password}`,
    "-e", "POSTGRES_DB=firsthand",
    "-p", "127.0.0.1:0:5432",
    "postgres:17"
  ]);

  const remove = async () => {
    await execFileAsync("docker", ["rm", "-f", containerName]).catch(() => {});
  };

  // EVERYTHING AFTER `docker run` HAS TO CLEAN UP AFTER ITSELF. The container
  // exists from this point on, but the caller has no handle to stop it until
  // this function returns - so a throw from the port lookup or the readiness
  // wait leaves it running, and `--rm` does not fire on a container that never
  // stopped. Carried over unnoticed from all three files this replaced.
  let connectionString: string;
  try {
    const { stdout } = await execFileAsync("docker", ["port", containerName, "5432"]);
    const mappedPort = stdout.trim().split("\n")[0]?.split(":").pop();
    if (!mappedPort) {
      throw new Error(`Could not determine the mapped Postgres port: ${stdout}`);
    }

    connectionString = `postgres://postgres:${password}@127.0.0.1:${mappedPort}/firsthand`;
    await waitForPostgres(connectionString);
  } catch (error) {
    await remove();
    throw error;
  }

  return { connectionString, stop: remove };
}

/**
 * `label` names the caller in the container name and the database name, so a
 * leftover from a killed run says which file left it.
 */
export async function startTestPostgres(label: string): Promise<TestPostgres> {
  const supplied = process.env[SUPPLIED_URL];
  return supplied
    ? useSuppliedServer(supplied, label)
    : startOwnContainer(label);
}
