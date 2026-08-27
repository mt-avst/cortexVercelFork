import express from 'express';
import session from 'express-session';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

const app = express();

// Demo configuration
const config = {
  port: 3001,
  nodeEnv: 'development',
  sessionSecret: 'demo_session_secret',
  corsOrigin: 'http://localhost:3000',
};

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false,
}));

// CORS configuration
app.use(cors({
  origin: config.corsOrigin,
  credentials: true,
}));

// Rate limiting (disabled for demo routes)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many authentication attempts, please try again later.',
  skip: (req) => {
    // Skip rate limiting for demo routes
    return req.path === '/auth/login' || req.path === '/auth/admin-login' || req.path === '/auth/demo-login';
  },
});

// Session configuration - use memory store for demo
app.use(session({
  secret: config.sessionSecret,
  name: 'adaptalabs_session',
  resave: false, // Don't force session save - only save when modified
  saveUninitialized: false, // Don't save uninitialized sessions
  rolling: true, // Reset expiration on activity
  cookie: {
    secure: false, // HTTP for demo (set to true in production with HTTPS)
    httpOnly: true, // Prevent XSS attacks
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    sameSite: 'lax', // CSRF protection
    domain: 'localhost', // Set domain to allow sharing between localhost:3000 and localhost:3001
    path: '/', // Explicitly set path
  },
}));

// Body parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Demo auth routes
app.get('/auth/demo-login', (req, res) => {
  // Demo: Create a mock user session
  const demoUser = {
    id: 'demo-user-123',
    name: 'Demo User',
    email: 'demo@example.com',
    business_unit: 'Engineering',
    role_title: 'Software Engineer',
    role: 'employee' as const,
  };
  
  req.session.user = demoUser;
  console.log('Setting session for demo user:', demoUser);
  console.log('Session ID:', req.sessionID);
  
  // Force session save and redirect
  req.session.save((err) => {
    if (err) {
      console.error('Session save error:', err);
      return res.status(500).json({ error: 'Session creation failed' });
    }
    console.log('Session saved, redirecting to:', config.corsOrigin);
    res.redirect(config.corsOrigin);
  });
});

app.get('/auth/login', (req, res) => {
  // Demo: Create a mock user session
  const demoUser = {
    id: 'demo-user-123',
    name: 'Demo User',
    email: 'demo@example.com',
    business_unit: 'Engineering',
    role_title: 'Software Engineer',
    role: 'employee' as const,
  };
  
  req.session.user = demoUser;
  console.log('Setting session for demo user:', demoUser);
  console.log('Session ID:', req.sessionID);
  
  // Force session save and redirect
  req.session.save((err) => {
    if (err) {
      console.error('Session save error:', err);
      return res.status(500).json({ error: 'Session creation failed' });
    }
    console.log('Session saved, redirecting to:', config.corsOrigin);
    res.redirect(config.corsOrigin);
  });
});

app.get('/auth/admin-login', (req, res) => {
  // Demo: Create a mock admin user session
  const demoAdmin = {
    id: 'b96e81d0-be56-40bd-9eee-bdb95ef2d273',
    name: 'Demo Admin',
    email: 'admin@example.com',
    business_unit: 'Research',
    role_title: 'Research Manager',
    role: 'researcher_admin' as const,
  };
  
  req.session.user = demoAdmin;
  console.log('Setting session for demo admin:', demoAdmin);
  console.log('Session ID:', req.sessionID);
  
  req.session.save((err) => {
    if (err) {
      console.error('Session save error:', err);
      return res.status(500).json({ error: 'Session creation failed' });
    }
    console.log('Admin session saved, redirecting to admin dashboard:', `${config.corsOrigin}/admin`);
    res.redirect(`${config.corsOrigin}/admin`);
  });
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.clearCookie('adaptalabs_session');
    res.json({ success: true });
  });
});

// Demo API routes
app.get('/api/me', (req, res) => {
  console.log('API /me called, session:', req.session);
  console.log('Session user:', req.session?.user);
  console.log('Session ID:', req.sessionID);
  
  if (!req.session?.user) {
    console.log('No user in session, returning 401');
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  console.log('Returning user data:', req.session.user);
  res.json(req.session.user);
});

// Demo opportunities API
app.get('/api/opportunities', (req, res) => {
  console.log('API /opportunities called');
  
  // Return empty opportunities array - user will create their own test data
  const mockOpportunities: any[] = [];
  
  res.json(mockOpportunities);
});

app.get('/api/opportunities/:id', (req, res) => {
  const { id } = req.params;
  console.log('API /opportunities/:id called with id:', id);
  
  // Return empty opportunities array - user will create their own test data
  const mockOpportunities: any[] = [];
  
  const opportunity = mockOpportunities.find(opp => opp.id === id);
  if (!opportunity) {
    return res.status(404).json({ error: 'Opportunity not found' });
  }
  
  res.json(opportunity);
});

// Demo sessions API
app.get('/api/opportunities/:id/sessions', (req, res) => {
  const { id } = req.params;
  console.log('API /opportunities/:id/sessions called with id:', id);
  
  const mockSessions = [
    {
      id: 'session-1',
      opportunity_id: id,
      start_time: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      end_time: new Date(Date.now() + 24 * 60 * 60 * 1000 + 30 * 60 * 1000).toISOString(),
      capacity: 5,
      booked_count: 2,
      location_or_meet_link_optional: 'Conference Room A',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      remaining: 3
    },
    {
      id: 'session-2',
      opportunity_id: id,
      start_time: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
      end_time: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000 + 30 * 60 * 1000).toISOString(),
      capacity: 3,
      booked_count: 0,
      location_or_meet_link_optional: 'Conference Room B',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      remaining: 3
    }
  ];
  
  res.json(mockSessions);
});

// Demo booking API
app.post('/api/sessions/:id/book', (req, res) => {
  const { id: sessionId } = req.params;
  console.log('API POST /sessions/:id/book called with sessionId:', sessionId);
  
  // Check if user is authenticated
  if (!req.session.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  // Mock booking response.
  //
  // `calendar: 'not_configured'` and no event id, matching the real route
  // (cto/AdaptaLabs#89). This answered `'success'` with a fabricated
  // `demo-event-<now>` id, which is the exact symptom that issue exists to
  // remove - and this is the one place a developer reproducing it locally would
  // still have seen it.
  const mockBooking = {
    id: 'booking-' + Date.now(),
    session_id: sessionId,
    status: 'booked',
    calendar: 'not_configured',
    calendarEventId: undefined
  };
  
  console.log(`📅 Demo: No calendar event created for booking ${mockBooking.id} (calendar not configured)`);
  console.log(`📧 Demo: Sent confirmation email to ${req.session.user.email}`);
  console.log(`📧 Demo: Sent notification email to researcher`);
  
  res.status(201).json(mockBooking);
});

app.post('/api/bookings/:id/cancel', (req, res) => {
  const { id: bookingId } = req.params;
  console.log('API POST /bookings/:id/cancel called with bookingId:', bookingId);
  
  // Check if user is authenticated
  if (!req.session.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  console.log(`📅 Demo: Cancelled calendar event for booking ${bookingId}`);
  console.log(`📧 Demo: Sent cancellation email to ${req.session.user.email}`);
  console.log(`📧 Demo: Sent notification email to researcher`);
  res.json({ message: 'Booking cancelled successfully' });
});

app.post('/api/bookings/:id/reschedule', (req, res) => {
  const { id: bookingId } = req.params;
  const { target_session_id } = req.body;
  console.log('API POST /bookings/:id/reschedule called with bookingId:', bookingId, 'target:', target_session_id);
  
  // Check if user is authenticated
  if (!req.session.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  if (!target_session_id) {
    return res.status(400).json({ error: 'target_session_id is required' });
  }
  
  console.log(`📅 Demo: Updated calendar event for booking ${bookingId} to session ${target_session_id}`);
  console.log(`📧 Demo: Sent updated confirmation email to ${req.session.user.email}`);
  res.json({ message: 'Booking rescheduled successfully' });
});

app.get('/api/my/bookings', (req, res) => {
  console.log('API GET /my/bookings called');
  
  // Check if user is authenticated
  if (!req.session.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  // Mock bookings response
  const mockBookings = {
    upcoming: [
      {
        id: 'booking-1',
        session_id: 'session-1',
        status: 'booked',
        session_start_time: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        session_end_time: new Date(Date.now() + 24 * 60 * 60 * 1000 + 30 * 60 * 1000).toISOString(),
        session_capacity: 5,
        session_location: 'Conference Room A',
        opportunity_title: 'User Interface Testing',
        opportunity_type: 'test',
        opportunity_purpose: 'Help us test the new user interface design',
        owner_name: 'Demo Admin',
        owner_email: 'admin@example.com',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    ],
    past: []
  };
  
  res.json(mockBookings);
});

app.get('/api/opportunities/:id/bookings', (req, res) => {
  const { id: opportunityId } = req.params;
  console.log('API GET /opportunities/:id/bookings called with opportunityId:', opportunityId);
  
  // Check if user is authenticated and admin
  if (!req.session.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  if (req.session.user.role !== 'researcher_admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  
  // Mock bookings for opportunity
  const mockBookings = [
    {
      id: 'booking-1',
      session_id: 'session-1',
      status: 'booked',
      start_time: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      end_time: new Date(Date.now() + 24 * 60 * 60 * 1000 + 30 * 60 * 1000).toISOString(),
      participant_name: 'Demo User',
      participant_email: 'demo@example.com',
      business_unit: 'Engineering',
      role_title: 'Software Engineer'
    }
  ];
  
  res.json(mockBookings);
});

// Admin endpoints for demo
app.delete('/api/opportunities/:id', (req, res) => {
  console.log(`Demo: Delete opportunity ${req.params.id}`);
  res.json({ success: true });
});

app.post('/api/opportunities/:id/duplicate', (req, res) => {
  console.log(`Demo: Duplicate opportunity ${req.params.id}`);
  // Return a mock duplicated opportunity
  const duplicatedOpportunity = {
    id: `opp-${Date.now()}`,
    type: 'test',
    title: 'Duplicated Opportunity',
    purpose_one_liner: 'This is a duplicated opportunity',
    description_optional: 'Demo duplicated opportunity',
    product_optional: 'Demo Product',
    default_duration_minutes: 30,
    status: 'draft',
    owner_user_id: 'b96e81d0-be56-40bd-9eee-bdb95ef2d273',
    external_link_optional: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    owner_name: 'Demo Admin',
    owner_email: 'admin@example.com',
    sessions: []
  };
  res.json(duplicatedOpportunity);
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handling
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(config.port, () => {
  console.log(`🚀 Demo server running on port ${config.port}`);
  console.log(`📱 Environment: ${config.nodeEnv}`);
  console.log(`🔗 CORS origin: ${config.corsOrigin}`);
  console.log(`\n📋 Demo endpoints:`);
  console.log(`   GET  /auth/login      - Login as regular user`);
  console.log(`   GET  /auth/admin-login - Login as admin user`);
  console.log(`   POST /auth/logout     - Logout`);
  console.log(`   GET  /api/me          - Get current user`);
  console.log(`   GET  /health          - Health check`);
});

export default app;
