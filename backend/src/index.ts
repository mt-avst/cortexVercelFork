import express from 'express';
import session from 'express-session';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import cron from 'node-cron';
import { config, pool } from './config';
import { logger } from './utils/logger';
import { applyServerTimeouts } from './server-timeouts';
import { createDatabaseHealthProbe } from './utils/deepHealth';
import { errorHandler } from './utils/errorHandler';
import { getBuildRevision } from './utils/buildInfo';
import { buildCsrfProtection, CSRF_ERROR_CODE } from './middleware/csrf';
import { sendDueReminders } from './services/reminders';
import { runFirstHandMaintenance } from './firsthand/maintenance';
import { isPostgresRuntimeConfigured } from './firsthand/runtime-database';
import authRoutes from './routes/auth';
import { createAuthLimiter } from './middleware/auth-rate-limit';
import apiRoutes from './routes/api';
import cronRoutes from './routes/cron';
import { SECURITY_CONFIG } from '../../shared/constants';

/**
 * THE LARGEST PARSED REQUEST BODY, stated rather than inherited (#22).
 *
 * Identical to express's own default, on purpose - nothing about today's
 * behaviour changes. Written down because several routes were relying on it as
 * their only bound without anyone deciding that, and an inherited default is
 * not a control: raising this for one route silently widens every other.
 *
 * Written as a STRING LITERAL here and asserted as the same literal in the test
 * rather than derived from this constant.
 */
export const BODY_SIZE_LIMIT = '100kb';

const app: express.Application = express();

// Trust proxy configuration for accurate IP addresses
// This is needed when behind a reverse proxy (e.g., Vercel, nginx)
// For production: Set to number of proxies (e.g., '1' for single reverse proxy)
// For development: Set to 'false' or '0' to disable (safer for local dev)
if (process.env.TRUST_PROXY === 'false' || process.env.TRUST_PROXY === '0') {
  // Disable trust proxy for local development
  app.set('trust proxy', false);
} else if (process.env.TRUST_PROXY && !isNaN(Number(process.env.TRUST_PROXY))) {
  // Use specific number of proxies (e.g., '1' for single reverse proxy)
  app.set('trust proxy', Number(process.env.TRUST_PROXY));
} else if (config.NODE_ENV === 'production') {
  // Production: Default to 1 proxy (common for Vercel, etc.)
  app.set('trust proxy', 1);
} else {
  // Development: Don't trust proxies by default (safer)
  app.set('trust proxy', false);
}

// The recorded-study runtime has no non-postgres fallback: without a database
// URL its writes throw but its READS return empty-as-real (not_found / []),
// which in production would silently present a working app with no data.
// Fail the boot instead - the URL is always injected on Kubera (DB_URL).
if (config.NODE_ENV === 'production' && !isPostgresRuntimeConfigured()) {
  throw new Error(
    'Recorded-study persistence requires DATABASE_URL, POSTGRES_URL or DB_URL in production.'
  );
}

// Chrome DevTools discovery endpoint (for development)
// Define BEFORE helmet to avoid CSP issues
if (config.NODE_ENV === 'development') {
  app.get('/.well-known/appspecific/com.chrome.devtools.json', (req, res) => {
    // Return proper workspace configuration for Chrome DevTools
    const path = require('path');
    const projectRoot = path.resolve(__dirname, '../..');
    
    res.json({
      workspace: {
        root: projectRoot,
        uuid: 'adaptalabs-workspace-dev'
      }
    });
  });
}

// Security middleware
if (config.NODE_ENV === 'production') {
  // Production: Use helmet with standard security headers
  app.use(helmet({
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
  }));
} else {
  // Development: Don't use helmet at all to avoid CSP issues
  // This allows Chrome DevTools and other dev tools to work properly
  console.log('Development mode: Helmet disabled to allow DevTools');
  
  // Middleware to prevent CSP headers from being set
  app.use((req, res, next) => {
    // Override setHeader to block CSP headers
    const originalSetHeader = res.setHeader.bind(res);
    res.setHeader = function(name: string, value: string | number | string[]) {
      const headerName = name.toLowerCase();
      if (headerName !== 'content-security-policy' && 
          headerName !== 'x-content-security-policy' && 
          headerName !== 'x-webkit-csp') {
        return originalSetHeader(name, value);
      }
      // Silently ignore CSP headers
      return res;
    };
    next();
  });
}

// CORS configuration
app.use(cors({
  origin: config.CORS_ORIGIN,
  credentials: true,
}));

// Request logging middleware
app.use(logger.requestLogger());

// Rate limiting for auth routes (excluding demo routes)
const authLimiter = createAuthLimiter();

// Session configuration
app.use(session({
  secret: config.SESSION_SECRET,
  name: 'adaptalabs_session',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: config.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: SECURITY_CONFIG.SESSION_MAX_AGE_MS,
    sameSite: config.NODE_ENV === 'production' ? 'strict' : 'lax',
    domain: config.NODE_ENV === 'production' ? undefined : 'localhost', // Allow cross-port cookie sharing in development
  },
}));

// CSRF protection - double-submit cookie via csrf-csrf (csurf is deprecated
// and was never wired to the SPA, which is why it broke in production).
// Default ON in production; set ENABLE_CSRF=false to disable, or
// ENABLE_CSRF=true to force-enable in development.
const csrfEnabled =
  process.env.ENABLE_CSRF === 'true' ||
  (config.NODE_ENV === 'production' && process.env.ENABLE_CSRF !== 'false');
if (csrfEnabled) {
  app.use(cookieParser());

  const { doubleCsrfProtection, generateCsrfToken } = buildCsrfProtection({
    secret: config.SESSION_SECRET,
    secureCookies: config.NODE_ENV === 'production',
  });

  // Token issuance: touching the session makes it persist (saveUninitialized
  // is false), so anonymous visitors get a stable session id for the token
  // to bind to. The SPA fetches this once and echoes the token in the
  // x-csrf-token header on every mutating request.
  app.get('/api/csrf-token', (req: express.Request, res: express.Response) => {
    req.session.csrfSeeded = true;
    res.json({ csrfToken: generateCsrfToken(req, res) });
  });

  app.use(doubleCsrfProtection);

  app.use((err: Error & { code?: string }, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err.code === CSRF_ERROR_CODE) {
      logger.warn('CSRF token validation failed', {
        method: req.method,
        url: req.url,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
      });
      return res.status(403).json({ error: 'Invalid CSRF token', code: CSRF_ERROR_CODE });
    }
    return next(err);
  });
}

// Body parsing middleware. The raw-body capture that fed the HMAC callback
// signature check is gone with the callback route — nothing reads req.rawBody now.
//
// THE LIMIT IS NAMED RATHER THAN INHERITED (#22). '100kb' is express's own
// default, so this changes nothing that runs today - deliberately. What it
// changes is the status of the number: several routes accepting unbounded
// arrays were bounded ONLY by this default, which means they were bounded by an
// accident of the framework that moves the moment somebody raises it here for
// an unrelated reason. Those arrays now carry their own bounds
// (MAX_TIME_SLOTS_PER_REQUEST), and this is a decision with a name on it rather
// than a side effect.
//
// Recording uploads are unaffected: they arrive as video/* and stream past this
// parser, with their own ceiling in getMaximumRecordingSizeBytes.
app.use(express.json({ limit: BODY_SIZE_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: BODY_SIZE_LIMIT }));

// Routes
app.use('/auth', authLimiter, authRoutes);
// Also mount auth routes under /api/auth for frontend compatibility
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/cron', cronRoutes);
// Deep health check. Registered BEFORE the /api router so it wins the path,
// and served under /api because the frontend nginx proxy forwards only /api
// and /auth to this private backend - a route under /health would be
// unreachable from outside the cluster and so useless to monitoring.
//
// Unlike /health below this one really touches the pool, which is what makes a
// durably dead database visible to something other than the app's own 503s.
// Rate limited because it is unauthenticated and does I/O. Issue #3.
// The probe dedupes concurrent callers and briefly reuses a verdict, so the
// database cost is constant regardless of request rate. That is what makes the
// generous ceiling below safe: behind two proxy hops `trust proxy: 1` resolves
// req.ip to the ingress, so this bucket is shared by every external caller and
// a tight limit would let anyone 429 the monitor - which reads as "unhealthy"
// and would make the endpoint lie in the direction it exists to prevent.
const healthLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
});

const databaseHealthProbe = createDatabaseHealthProbe(pool);

app.get('/api/health', healthLimiter, (_req: express.Request, res: express.Response, next: express.NextFunction) => {
  // Express 4 does not forward a rejected promise to the error handler, and an
  // unhandled rejection terminates the process under Node 22. checkDatabaseHealth
  // is documented and tested never to reject, but the endpoint added to survive
  // a database failure is the wrong place to rely on that.
  databaseHealthProbe()
    .then((database) => {
      res.set('Cache-Control', 'no-store');
      res.status(database.healthy ? 200 : 503).json({
        status: database.healthy ? 'ok' : 'degraded',
        database: database.healthy ? 'up' : 'down',
        // Reported on the healthy path only. On failure it is a latency oracle
        // - an immediate refusal versus a blackholed connection sitting at the
        // timeout - and `status` already carries everything monitoring needs.
        ...(database.healthy ? { databaseLatencyMs: database.latencyMs } : {}),
        // Reported on BOTH paths, unlike databaseLatencyMs above. Which build
        // is running is most worth knowing precisely when the app is
        // unhealthy - "is this the broken release or the fix?" - so withholding
        // it on the failure path would answer the question only when nobody
        // needs to ask it. It is a commit sha rather than recon detail: it says
        // nothing about the state of the system, only which source produced it.
        revision: getBuildRevision(),
        timestamp: new Date().toISOString(),
      });
    })
    .catch(next);
});

app.use('/api', apiRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error logging middleware
app.use(logger.errorLogger());

// Error handling middleware
app.use(errorHandler);

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

// Start server. Guarded like the cron schedules above so the app can be
// imported by tests and driven with supertest without binding a port - which
// is what lets a test pin the real middleware order rather than a copy of it.
if (process.env.NODE_ENV !== 'test') {
  // The socket bounds are applied to the server `listen` returns, not left at
  // Node's defaults. `server.timeout` defaults to 0 - no bound at all on a
  // socket that goes quiet mid-request - which is how one admin reading
  // nothing could hold the single results-read permit indefinitely. See
  // server-timeouts.ts for why each number is what it is.
  applyServerTimeouts(app.listen(config.PORT, () => {
    logger.info('Server started', {
      port: config.PORT,
      environment: config.NODE_ENV,
      corsOrigin: config.CORS_ORIGIN,
      csrfEnabled,
    });
  }));
}

export default app;
