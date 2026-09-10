import { describe, it, expect } from 'vitest';
import packageJson from '../../../package.json';

/**
 * NO ERROR-REPORTING SDK MAY LAND WITHOUT ITS OWN beforeSend SCRUBBER.
 * cto/AdaptaLabs#102 (the tracked ceiling on cto/AdaptaLabs#88), made
 * un-crossable-silently instead of relying on the next integrator reading it.
 *
 * #88 redacts request bodies and headers from every line THIS frontend's logger
 * emits (`redactRequestBodies` in ../logger). It cannot reach an error-reporting
 * SDK (Sentry/Bugsnag/Datadog/…): those capture unhandled rejections and
 * uncaught exceptions with their OWN serialisers, which walk an AxiosError's
 * `config.data` (the request body, including researcher notes) and
 * `config.headers` (the CSRF token rides every mutating request). So the first
 * SDK integration would re-open the exact leak #88 closed, through a door the
 * logger never sees.
 *
 * This guard fails the build the moment a known browser error-reporting package
 * appears in frontend/package.json. It is a DEPENDENCY-level tripwire, not a
 * proof the scrubber exists - that cannot be asserted before any SDK or init
 * site exists without being brittle. Its job is to force a conscious stop and
 * name the fix.
 *
 * THE CORRECT FIX MAKES IT GREEN (a tripwire must never fire on the correct
 * fix): the SDK-integration MR wires a `beforeSend`/`beforeBreadcrumb` scrubber
 * reusing the redaction policy from ../logger (`redactRequestBodies` and its
 * `carriesRequestBody` shape predicate - drop `config.data`, `config.headers`,
 * and consider `response.data`), and THEN adds the package name to
 * `ACKNOWLEDGED_WITH_SCRUBBER` below. Adding the name is the acknowledgement,
 * and - like eslint-suppressions or a mutation-canary entry - it is a
 * deliberate, reviewable edit whose meaning is stated at the site. Silencing it
 * without wiring the scrubber is possible but no longer accidental.
 */

/**
 * Package-name patterns for BROWSER error-reporting SDKs whose capture path
 * bypasses the logger. Extend this list as new ones appear; the controls below
 * prove it still detects and does not over-match.
 */
const ERROR_REPORTING_MATCHERS: readonly RegExp[] = [
  /^@sentry\//,
  /^bugsnag(-js)?$/,
  /^@bugsnag\//,
  /^rollbar$/,
  /^@datadog\/browser-(rum|logs)/,
  /^@honeybadger-io\//,
  /^raygun4js$/,
  /^trackjs$/,
  /^@airbrake\//,
  /^@grafana\/faro-/,
  /^@elastic\/apm-rum/,
  /^elastic-apm-/,
];

/**
 * Packages deliberately admitted AFTER their beforeSend scrubber is wired (see
 * the docblock). EMPTY today because no error-reporting SDK is integrated. An
 * entry here asserts: "this SDK is integrated WITH a request-body/header
 * scrubber reusing redactRequestBodies from src/utils/logger.ts."
 */
const ACKNOWLEDGED_WITH_SCRUBBER: readonly string[] = [];

const isErrorReporter = (name: string): boolean =>
  ERROR_REPORTING_MATCHERS.some((re) => re.test(name));

/** The pure core, so the controls can exercise it without touching disk. */
export const unacknowledgedReporters = (
  depNames: readonly string[],
  acknowledged: readonly string[],
): string[] => depNames.filter((n) => isErrorReporter(n) && !acknowledged.includes(n));

const declaredDependencies = (): string[] => {
  const pkg = packageJson as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  return [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ];
};

const FAILURE_MESSAGE =
  'An error-reporting SDK is in frontend/package.json without acknowledgement (cto/AdaptaLabs#102).\n' +
  "Its capture path serialises errors with its own serialiser and would leak an AxiosError's " +
  'config.data (request body, incl. researcher notes) and config.headers (CSRF token) - the exact ' +
  'leak #88 closed in the logger, which an SDK bypasses.\n' +
  'Before shipping it: wire a beforeSend/beforeBreadcrumb scrubber reusing redactRequestBodies ' +
  '(and its carriesRequestBody predicate) from src/utils/logger.ts, then add the package name to ' +
  'ACKNOWLEDGED_WITH_SCRUBBER in this test.';

describe('no error-reporting SDK ships without a beforeSend scrubber (#102)', () => {
  it('frontend/package.json declares no unacknowledged error-reporting SDK', () => {
    const offenders = unacknowledgedReporters(declaredDependencies(), ACKNOWLEDGED_WITH_SCRUBBER);
    expect(offenders, `${FAILURE_MESSAGE}\nOffending package(s): ${offenders.join(', ')}`).toEqual([]);
  });

  // CONTROL: the guard can fail. Without this, a matcher that matched nothing
  // would pass the real assertion above forever and protect nothing.
  it('flags a known SDK when it is present and NOT acknowledged', () => {
    expect(
      unacknowledgedReporters(['react', 'axios', '@sentry/react'], []),
    ).toEqual(['@sentry/react']);
  });

  // CONTROL: the correct fix goes green. An SDK present AND acknowledged (i.e.
  // its scrubber wired) must not fire - a tripwire must never fire on the fix.
  it('does not flag an SDK once it is acknowledged with a scrubber', () => {
    expect(
      unacknowledgedReporters(['react', '@sentry/react'], ['@sentry/react']),
    ).toEqual([]);
  });

  it('the matcher detects the known browser error-reporting SDKs', () => {
    for (const name of [
      '@sentry/react',
      '@sentry/browser',
      'bugsnag-js',
      '@bugsnag/js',
      'rollbar',
      '@datadog/browser-rum',
      '@datadog/browser-logs',
      '@grafana/faro-web-sdk',
      '@elastic/apm-rum',
    ]) {
      expect(isErrorReporter(name), name).toBe(true);
    }
  });

  it('the matcher does not flag ordinary dependencies', () => {
    for (const name of [
      'react',
      'react-dom',
      'axios',
      'vitest',
      'typescript',
      '@testing-library/react',
      '@vitejs/plugin-react',
      'react-router-dom',
    ]) {
      expect(isErrorReporter(name), name).toBe(false);
    }
  });
});
