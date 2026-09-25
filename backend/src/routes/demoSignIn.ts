import express, { Router, Request, Response } from 'express';

import { pool } from '../config';
import { findDemoAccount } from '../services/demoCredentials';
import { SessionUser, isAdminRole } from '../types';
import { logger } from '../utils/logger';

/**
 * GET/POST /auth/demo-login - password sign-in for the seeded demo accounts on
 * Vercel previews. Mounted by routes/auth.ts only when
 * isCredentialedDemoLoginEnabled() (services/demoCredentials.ts) says so; the
 * open, credential-less demo routes stay development-only.
 *
 * CSRF: a plain HTML form cannot send the x-csrf-token header the double-submit
 * check reads, and body parsing runs after that check, so this POST is exempt
 * from it (middleware/csrf.ts) and checks Origin instead: a cross-site form
 * post carries a foreign Origin and is refused before any credential is read.
 */
const router: Router = Router();

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function page(error?: string, email = ''): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cortex preview sign-in</title></head>
<body>
<main>
<h1>Cortex preview sign-in</h1>
<p>This is a test copy. Sign in with a seeded demo account.</p>
${error ? `<p role="alert"><strong>${escapeHtml(error)}</strong></p>` : ''}
<form method="post" action="/auth/demo-login">
<p><label>Email<br><input name="email" type="email" autocomplete="username" required value="${escapeHtml(email)}"></label></p>
<p><label>Password<br><input name="password" type="password" autocomplete="current-password" required></label></p>
<p><button type="submit">Sign in</button></p>
</form>
</main>
</body></html>`;
}

function sendPage(res: Response, status: number, error?: string, email?: string): void {
  res.status(status).set('Cache-Control', 'no-store').type('html').send(page(error, email));
}

/** Same-origin check for the form post: the browser's Origin must be this host. */
export function isSameOrigin(req: Request): boolean {
  const origin = req.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).host === req.get('host');
  } catch {
    return false;
  }
}

router.get('/demo-login', (_req: Request, res: Response) => {
  sendPage(res, 200);
});

router.post(
  '/demo-login',
  express.urlencoded({ extended: false, limit: '4kb' }),
  async (req: Request, res: Response) => {
    if (!isSameOrigin(req)) {
      logger.warn('Demo sign-in refused: cross-origin or missing Origin', { origin: req.get('origin') });
      return sendPage(res, 403, 'Sign-in must come from this page.');
    }

    const email = typeof req.body?.email === 'string' ? req.body.email.slice(0, 254) : '';
    const password = typeof req.body?.password === 'string' ? req.body.password.slice(0, 512) : '';

    let account;
    try {
      const client = await pool.connect();
      try {
        account = await findDemoAccount(client, email, password);
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error('Demo sign-in lookup failed', { error });
      return sendPage(res, 500, 'Sign-in is unavailable right now.', email);
    }

    if (!account) {
      logger.warn('Demo sign-in failed');
      return sendPage(res, 401, 'Email or password is incorrect.', email);
    }

    const sessionUser: SessionUser = {
      id: account.id,
      name: account.name,
      email: account.email,
      business_unit: account.business_unit,
      role_title: account.role_title,
      role: account.role as SessionUser['role'],
    };

    // Regenerate to prevent session fixation, as the OIDC callback does.
    req.session.regenerate((regenErr) => {
      if (regenErr) {
        logger.error('Session regeneration failed', { error: regenErr });
        return sendPage(res, 500, 'Sign-in is unavailable right now.');
      }
      req.session.user = sessionUser;
      req.session.save((saveErr) => {
        if (saveErr) {
          logger.error('Session save failed', { error: saveErr });
          return sendPage(res, 500, 'Sign-in is unavailable right now.');
        }
        logger.info('Demo sign-in succeeded', { userId: account.id, role: account.role });
        res.redirect(303, isAdminRole(account.role) ? '/admin' : '/');
      });
    });
  }
);

export default router;
