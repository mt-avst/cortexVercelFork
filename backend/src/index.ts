import express from 'express';
import session from 'express-session';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import csurf from 'csurf';
import { config } from './config';
import { logger } from './utils/logger';
import { errorHandler } from './utils/errorHandler';
import authRoutes from './routes/auth';
import apiRoutes from './routes/api';
import { TIME_INTERVALS, RATE_LIMITS, SECURITY_CONFIG } from '../../shared/constants';

const app: express.Application = express();

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false, // Disable for development
}));

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
if (config.NODE_ENV === 'production' || config.ENABLE_CSRF) {
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

// Body parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/auth', authLimiter, authRoutes);
app.use('/api', apiRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error logging middleware
app.use(logger.errorLogger());

// Error handling middleware
app.use(errorHandler);

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
