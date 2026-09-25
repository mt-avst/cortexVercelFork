type Env = Record<string, string | undefined>;

/**
 * WHETHER THE DEMO SIGN-IN ROUTES EXIST (/auth/demo-login, /auth/admin-login,
 * and the demo fallbacks of /auth/login and /auth/google-login).
 *
 * They sign anyone in as a seeded demo user or demo ADMIN with no credential,
 * so they have only ever existed under NODE_ENV=development.
 *
 * The one addition: a Vercel PREVIEW deployment may opt in with
 * ENABLE_DEMO_LOGIN=true. Previews get a new hostname per branch, which the
 * Okta app has no redirect URI for, so without this a preview cannot be signed
 * into at all. Both conditions are required:
 *
 * - VERCEL_ENV is set by the platform itself and is 'preview' only on preview
 *   deployments - never 'production' - so no value of ENABLE_DEMO_LOGIN can turn
 *   this on for production, or anywhere off Vercel.
 * - Previews sit behind Vercel Deployment Protection (team sign-in before the
 *   page loads), so only AdaptaWorks team members reach these routes.
 *
 * ponytail: demo sign-in on previews stands in for real SSO on previews
 *   -> replace with an Okta app whose redirect URIs cover the preview domain
 *      before previews carry anything but seed data.
 */
export function isDemoLoginAllowed(env: Env = process.env): boolean {
  if (env.NODE_ENV === 'development') return true;
  return env.ENABLE_DEMO_LOGIN === 'true' && env.VERCEL_ENV === 'preview';
}
