# Cortex on Vercel (this fork)

This fork runs Cortex on Vercel instead of Kubera. The live internal beta is untouched: it
still runs from the GitLab original (`cto/AdaptaLabs`) on the Kubera playground.

**Why this fork exists:** on Kubera a change is only testable after merging to `main`,
then a second pipeline run, a semantic-release tag, and an ArgoCD sync: 35 minutes at
best, often hours. On Vercel every pushed branch gets its own deployment and database
copy in a few minutes.

**Why Cortex left Vercel before (July 2026):** the old Vercel project was on a *personal*
account, and it held real participant recordings. That was a data-ownership problem, not
a technical one (`docs/FIRSTHAND-KUBERA-MIGRATION-ASSESSMENT.md` §1). The rules for this
fork follow from that:

- Deploy only to the company-owned **AdaptaWorks** Vercel team.
- Use test data only until the data-processing question has an answer for this host.

## How it is wired

| Path | Served by |
|---|---|
| `/*` | The Vite build (`frontend/dist`), static from the Vercel CDN. Unknown paths fall back to `index.html` (SPA routing). |
| `/api/*`, `/auth/*`, `/health` | `api/index.js`, one Vercel Function wrapping the compiled Express app (`backend/`), unchanged. |

- **Same origin.** The frontend and API share one origin, which the `__Host-` session cookie and `SameSite=Strict` need.
- **Page headers.** Security and cache headers for pages are set in `vercel.json` `headers` (nginx set them on Kubera), pinned by `scripts/vercel-config.test.js`.
- **Build.** `scripts/vercel-build.sh` compiles the backend, builds the frontend, then runs `migrate`, `seed` and `migrate:firsthand` against this deployment's own database. That is the chain the Kubera init container ran on every pod start. Migrations must stay additive (ADR 0005), because production migrates before the new build is promoted.
- **Login sessions** live in Postgres (`user_sessions`, `backend/src/config/sessionStore.ts`), because function instances share no memory.
- **Scheduled jobs.** Vercel Cron calls `/api/cron/send-reminders` (09:00 UTC) and `/api/cron/firsthand-maintenance` (03:00 UTC), sending `Bearer $CRON_SECRET` itself. The in-process `node-cron` and `app.listen` are skipped when `VERCEL` is set.

## Setting up the project (once)

1. **Create a project** in the AdaptaWorks team and import this GitHub repository. Leave
   the framework as "Other": `vercel.json` sets the install, build and output settings.
2. **Connect Neon** from the project's Storage tab, with preview branching on. Each preview
   deployment then gets its own database branch and `DATABASE_URL`. The backend refuses
   to boot in production without a database URL, so do this before the first deploy.
3. **Set the environment variables** below.
4. **Turn on Deployment Protection** for previews (Vercel Authentication), so only team
   members can open a preview.

| Variable | Needed | Value |
|---|---|---|
| `SESSION_SECRET` | yes | 32+ random characters (`openssl rand -hex 32`) |
| `CRON_SECRET` | yes | random string; Vercel Cron sends it automatically |
| `DATABASE_URL` | yes | set by the Neon integration |
| `SKIP_OIDC` | until Okta is set up | `true` (stops a failed discovery on every cold start) |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URL` | for sign-in | an Okta app whose redirect URI is `https://<domain>/auth/callback` |
| `BOOTSTRAP_SUPERADMIN_EMAILS` | optional | first sign-in by these addresses becomes superadmin |
| `CORS_ORIGIN` | optional | derived from the deployment's own URL when unset (`api/index.js`) |
| `EMAIL_SMTP_*`, `EMAIL_FROM` | optional | reminder and booking emails (use port 587) |
| `GOOGLE_OAUTH_*` | optional | Google Calendar connection |

## Not done yet

- **Sign-in on previews.** The Okta app has no redirect URI for Vercel preview hostnames,
  so a preview can serve pages and `/api/health` but nobody can sign in. The fix is either
  an Okta app whose redirect URIs cover the preview domain, or a fixed auth-callback host.
  The development-only demo sign-in routes are deliberately **not** enabled on Vercel.
- **Recordings and artefact uploads (S3).** On Kubera the pod's IAM role (IRSA) granted S3.
  Vercel needs AWS OIDC federation to an IAM role and a bucket for this fork. Until then,
  FirstHand recording uploads fail.
- **Per-instance limits.** Rate limiting (`express-rate-limit`) and the FirstHand connection
  admission gate (`firsthand/runtime-pool-admission.ts`) count per function instance, not
  globally. Both were written for one long-lived process.
- **Database TLS.** Connections to Neon are encrypted but the certificate is not verified
  (`DB_TLS_VERIFY` expects the bundled RDS CA).
- **CI.** None yet. See "Hosting and CI" in `AGENTS.md` for what to run before pushing.

## Checking it locally

```bash
npm ci --ignore-scripts && npm ci --prefix backend && npm ci --prefix frontend
DATABASE_URL=postgresql://postgres:password@localhost:5432/adaptalabs_dev \
SESSION_SECRET=$(openssl rand -hex 32) npx vercel build   # after `vercel link`; the same build Vercel runs
```
