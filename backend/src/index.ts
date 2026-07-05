import express from 'express';
import session from 'express-session';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import csurf from 'csurf';
import cron from 'node-cron';
import { config } from './config';
import { logger } from './utils/logger';
import { errorHandler } from './utils/errorHandler';
import { sendDueReminders } from './services/reminders';
import authRoutes from './routes/auth';
import apiRoutes from './routes/api';
import cronRoutes from './routes/cron';
import { TIME_INTERVALS, RATE_LIMITS, SECURITY_CONFIG } from '../../shared/constants';

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
const authLimiter = rateLimit({
  windowMs: RATE_LIMITS.WINDOW_MS,
  max: process.env.NODE_ENV === 'development' ? RATE_LIMITS.MAX_REQUESTS : RATE_LIMITS.MAX_AUTH_REQUESTS,
  message: 'Too many authentication attempts, please try again later.',
  skip: (req) => {
    // Skip rate limiting for demo routes in development
    const shouldSkip = process.env.NODE_ENV === 'development' && 
           (req.path === '/auth/demo-login' || req.path === '/auth/admin-login');
    if (shouldSkip) {
      console.log('Skipping rate limit for demo route:', req.path);
    }
    return shouldSkip;
  },
});

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

// CSRF protection (only for production or when explicitly enabled)
// TODO: Does not work on production (on container based envs). Need to fix.
if (config.NODE_ENV === 'production' && config.ENABLE_CSRF) {
  app.use((csurf as any)({
    cookie: {
      httpOnly: true,
      secure: config.NODE_ENV === 'production',
      sameSite: config.NODE_ENV === 'production' ? 'strict' : 'lax',
    },
    ignoreMethods: ['GET', 'HEAD', 'OPTIONS'],
  }));

  // CSRF error handler
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err.code === 'EBADCSRFTOKEN') {
      logger.warn('CSRF token validation failed', {
        method: req.method,
        url: req.url,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
      });
      return res.status(403).json({ error: 'Invalid CSRF token' });
    }
    next(err);
  });

  // Add CSRF token to response headers
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.locals.csrfToken = req.csrfToken();
    res.setHeader('X-CSRF-Token', req.csrfToken());
    next();
  });
}

// Body parsing middleware — capture raw body for webhook signature verification
app.use(express.json({
  verify: (req: any, _res, buf) => { req.rawBody = buf.toString('utf8'); }
}));
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/auth', authLimiter, authRoutes);
// Also mount auth routes under /api/auth for frontend compatibility
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/cron', cronRoutes);
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

// Start server
app.listen(config.PORT, () => {
  logger.info('Server started', {
    port: config.PORT,
    environment: config.NODE_ENV,
    corsOrigin: config.CORS_ORIGIN,
    csrfEnabled: config.NODE_ENV === 'production' || config.ENABLE_CSRF,
  });
});

export default app;
