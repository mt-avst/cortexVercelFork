import { Router } from 'express';
import { Issuer, Client } from 'openid-client';
import crypto from 'crypto';

import { pool } from '../config';

import { SessionUser } from '../types';

console.log('🔍 Auth module loaded, OIDC_ISSUER:', process.env.OIDC_ISSUER);

const router: Router = Router();
let client: Client;

// Store for state validation (in production, use Redis or similar)
const stateStore = new Map<string, { timestamp: number; used: boolean }>();

// Clean up expired states every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [state, data] of stateStore.entries()) {
    if (now - data.timestamp > 10 * 60 * 1000) { // 10 minutes
      stateStore.delete(state);
    }
  }
}, 10 * 60 * 1000);

// Initialize OIDC client
async function initializeClient() {
  try {
    console.log('🔍 OIDC Debug:', {
      NODE_ENV: process.env.NODE_ENV,
      OIDC_ISSUER: process.env.OIDC_ISSUER,
      OIDC_CLIENT_ID: process.env.OIDC_CLIENT_ID,
      OIDC_CLIENT_SECRET: process.env.OIDC_CLIENT_SECRET,
      OIDC_REDIRECT_URL: process.env.OIDC_REDIRECT_URL
    });
    
    // Skip OIDC initialization in development if issuer is not available or is a placeholder
    if (process.env.NODE_ENV === 'development' && 
        (!process.env.OIDC_ISSUER || 
         process.env.OIDC_ISSUER.includes('your-oidc-provider.com') ||
         process.env.OIDC_ISSUER.includes('demo-idp.com') ||
         process.env.OIDC_ISSUER.includes('your-idp.com'))) {
      console.log('Skipping OIDC initialization in development mode - using placeholder issuer');
      return;
    }
    
    const issuer = await Issuer.discover(process.env.OIDC_ISSUER!);
    client = new issuer.Client({
      client_id: process.env.OIDC_CLIENT_ID!,
      client_secret: process.env.OIDC_CLIENT_SECRET!,
      redirect_uris: [process.env.OIDC_REDIRECT_URL!],
      response_types: ['code'],
    });
    console.log('OIDC client initialized successfully');
  } catch (error) {
    console.error('Failed to initialize OIDC client:', error);
    // In development, we can continue without OIDC
    if (process.env.NODE_ENV !== 'development') {
      throw error;
    }
  }
}

// Initialize client on startup
initializeClient().catch((error) => {
  if (process.env.NODE_ENV === 'development') {
    console.log('OIDC initialization failed, continuing in development mode');
  } else {
    console.error('OIDC initialization failed:', error);
  }
});

/**
 * GET /auth/login - Initiate OIDC flow
 * 
 * Generates a cryptographically secure state parameter and redirects the user
 * to the OIDC provider for authentication. The state parameter is stored
 * temporarily to prevent CSRF attacks.
 * 
 * @param req - Express request object
 * @param res - Express response object
 * @returns Redirects to OIDC provider or returns 500 error
 */
router.get('/login', async (req, res) => {
  try {
    // Check if OIDC client is available
    if (!client) {
      if (process.env.NODE_ENV === 'development') {
        // In development, redirect to demo login
        return res.redirect('/auth/demo-login');
      } else {
        return res.status(500).json({ error: 'Authentication service unavailable' });
      }
    }
    
    // Generate cryptographically secure state parameter
    const state = crypto.randomBytes(32).toString('hex');
    
    // Store state with timestamp for validation
    stateStore.set(state, { timestamp: Date.now(), used: false });
    
    const authUrl = client.authorizationUrl({
      scope: 'openid profile email',
      state: state,
    });
    
    res.redirect(authUrl);
  } catch (error) {
    console.error('Login initiation failed:', error);
    res.status(500).json({ error: 'Login initiation failed' });
  }
});

/**
 * GET /auth/callback - Handle OIDC callback
 * 
 * Processes the OIDC callback from the identity provider, validates the state
 * parameter, exchanges the authorization code for tokens, retrieves user info,
 * and creates or updates the user in the database. Creates a secure session
 * and redirects the user to the frontend.
 * 
 * @param req - Express request object containing OIDC callback parameters
 * @param res - Express response object
 * @returns Redirects to frontend on success or returns error response
 */
router.get('/callback', async (req, res) => {
  try {
    // Check if OIDC client is available
    if (!client) {
      if (process.env.NODE_ENV === 'development') {
        // In development, redirect to demo login
        return res.redirect('/auth/demo-login');
      } else {
        return res.status(500).json({ error: 'Authentication service unavailable' });
      }
    }
    
    const params = client.callbackParams(req);
    const state = params.state;
    
    // Validate state parameter
    if (!state || !stateStore.has(state)) {
      console.error('Invalid or missing state parameter');
      return res.status(400).json({ error: 'Invalid state parameter' });
    }
    
    const stateData = stateStore.get(state);
    if (!stateData || stateData.used) {
      console.error('State parameter already used or expired');
      return res.status(400).json({ error: 'State parameter already used' });
    }
    
    // Mark state as used
    stateData.used = true;
    
    const tokenSet = await client.callback(process.env.OIDC_REDIRECT_URL!, params, {
      state: state,
    });

    // Get user info from token
    const userInfo = await client.userinfo(tokenSet.access_token!);
    
    // Extract user data from claims
    const userData = {
      name: userInfo.name || userInfo.preferred_username || 'Unknown User',
      email: userInfo.email!,
      business_unit: userInfo.department || userInfo.organization || null,
      role_title: userInfo.job_title || userInfo.title || null,
    };

    // Upsert user in database
    const dbClient = await pool.connect();
    try {
      const result = await dbClient.query(`
        INSERT INTO users (name, email, business_unit, role_title)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (email) 
        DO UPDATE SET 
          name = EXCLUDED.name,
          business_unit = EXCLUDED.business_unit,
          role_title = EXCLUDED.role_title
        RETURNING id, name, email, business_unit, role_title, role
      `, [userData.name, userData.email, userData.business_unit, userData.role_title]);

      const user = result.rows[0];
      
      // Create notification preferences if first login
      await dbClient.query(`
        INSERT INTO notification_preferences (user_id)
        VALUES ($1)
        ON CONFLICT (user_id) DO NOTHING
      `, [user.id]);

      // Create session user object
      const sessionUser: SessionUser = {
        id: user.id,
        name: user.name,
        email: user.email,
        business_unit: user.business_unit,
        role_title: user.role_title,
        role: user.role,
      };

      // Regenerate session to prevent fixation
      req.session.regenerate((err) => {
        if (err) {
          console.error('Session regeneration failed:', err);
          return res.status(500).json({ error: 'Session creation failed' });
        }
        
        req.session.user = sessionUser;
        req.session.save((err) => {
          if (err) {
            console.error('Session save failed:', err);
            return res.status(500).json({ error: 'Session creation failed' });
          }
          
          res.redirect(process.env.CORS_ORIGIN || 'http://localhost:3000');
        });
      });

    } finally {
      dbClient.release();
    }

  } catch (error) {
    console.error('Callback handling failed:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// POST /auth/logout - Destroy session
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Logout failed:', err);
      return res.status(500).json({ error: 'Logout failed' });
    }
    
    res.clearCookie('adaptalabs_session');
    res.json({ success: true });
  });
});

// Demo routes for development
if (process.env.NODE_ENV === 'development') {
  // GET /auth/demo-login - Demo user login
  router.get('/demo-login', (req, res) => {
    const demoUser: SessionUser = {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      name: 'Demo User',
      email: 'demo@example.com',
      business_unit: 'Engineering',
      role_title: 'Software Engineer',
      role: 'employee',
    };
    
    req.session.user = demoUser;
    
    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err);
        return res.status(500).json({ error: 'Session creation failed' });
      }
      res.redirect(process.env.CORS_ORIGIN || 'http://localhost:3000');
    });
  });

  // GET /auth/admin-login - Demo admin login
  router.get('/admin-login', (req, res) => {
    const demoAdmin: SessionUser = {
      id: '633608bc-4b0e-4d60-a498-e680ee97c252', // Use actual admin ID from database
      name: 'Test Admin',
      email: 'admin@test.com',
      business_unit: 'Research',
      role_title: 'Research Manager',
      role: 'researcher_admin',
    };
    
    req.session.user = demoAdmin;
    
    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err);
        return res.status(500).json({ error: 'Session creation failed' });
      }
      // Redirect admin users to admin dashboard
      const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:3000';
      res.redirect(`${corsOrigin}/admin`);
    });
  });
}

export default router;
