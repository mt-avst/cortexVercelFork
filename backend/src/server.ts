import cron from 'node-cron';

import { config } from './config';
import { logger } from './utils/logger';
import { applyServerTimeouts } from './server-timeouts';
import { betaAllAdminEnabled, betaAllAdminDomains } from './config/betaAllAdmin';
import { sendDueReminders } from './services/reminders';
import { runFirstHandMaintenance } from './firsthand/maintenance';
import { autoClosePublishedStudiesPastEndDate } from './utils/opportunityLifecycle';
import app, { csrfEnabled } from './index';

// The process entrypoint. index.ts assembles the app with no side effects; this
// module owns everything that runs the process - the cron schedules and the
// listen. Nothing imports this module except `node`/`tsx` starting it, so the
// app can be imported by tests without binding a port or scheduling a job (#153).
// The NODE_ENV !== 'test' guards are kept as belt-and-braces: a test that
// imported this file by mistake still binds nothing.

// Daily reminder emails at 09:00 UTC (single-replica deployment; the job is
// idempotent per booking via reminder_sent_at). Disable with REMINDER_CRON_DISABLED=true.
if (process.env.NODE_ENV !== 'test' && process.env.REMINDER_CRON_DISABLED !== 'true') {
  cron.schedule('0 9 * * *', async () => {
    try {
      const summary = await sendDueReminders();
      logger.info('Reminder cron run complete', { ...summary });
    } catch (err) {
      logger.error('Reminder cron run failed', { error: err });
    }
  });
}

// FirstHand maintenance at 03:00 UTC (single-replica deployment), folding the
// standalone app's daily maintenance cron in-process: the transcript backstop
// and the stale-upload reaper. runFirstHandMaintenance is best-effort and never
// throws. Disable with FIRSTHAND_MAINTENANCE_CRON_DISABLED=true.
if (
  process.env.NODE_ENV !== 'test' &&
  process.env.FIRSTHAND_MAINTENANCE_CRON_DISABLED !== 'true'
) {
  cron.schedule('0 3 * * *', async () => {
    await runFirstHandMaintenance();
  });
}

// Close published studies whose end_date has passed (Decision 3). Hourly rather
// than daily so a study stops advertising itself as live within the hour of the
// date its author set, not up to a day later. Single-replica deployment; the
// sweep is a set-based UPDATE that only moves published -> closed, so it is
// idempotent and safe to re-run. Disable with END_DATE_CLOSE_CRON_DISABLED=true.
if (
  process.env.NODE_ENV !== 'test' &&
  process.env.END_DATE_CLOSE_CRON_DISABLED !== 'true'
) {
  cron.schedule('0 * * * *', async () => {
    try {
      await autoClosePublishedStudiesPastEndDate();
    } catch (err) {
      logger.error('End-date auto-close cron run failed', { error: err });
    }
  });
}

// Start server. Guarded like the cron schedules above so the app can be
// imported by tests and driven with supertest without binding a port - which
// is what lets a test pin the real middleware order rather than a copy of it.
if (process.env.NODE_ENV !== 'test') {
  // The socket bounds are applied to the server `listen` returns, not left at
  // Node's defaults. `server.timeout` defaults to 0 - no bound at all on a
  // socket that goes quiet mid-request - which is how one admin reading
  // nothing could hold the single results-read permit indefinitely. See
  // server-timeouts.ts for why each number is what it is.
  if (betaAllAdminEnabled()) {
    logger.warn(
      'CORTEX_BETA_ALL_ADMIN is ON: signed-in employees on these email domains ' +
        'are elevated to admin (superadmin is unaffected). Temporary beta switch, ' +
        'MUST be off at go-live.',
      { domains: betaAllAdminDomains() }
    );
  }

  applyServerTimeouts(app.listen(config.PORT, () => {
    logger.info('Server started', {
      port: config.PORT,
      environment: config.NODE_ENV,
      corsOrigin: config.CORS_ORIGIN,
      csrfEnabled,
    });
  }));
}
