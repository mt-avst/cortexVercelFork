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

1. **Create a project** in the AdaptaWorks team and import this GitHub repository
   (done 2026-09-25: `cortex-vercel`, Vercel Authentication on every deployment URL). Leave
   the framework as "Other": `vercel.json` sets the install, build and output settings.
2. **Connect Neon** from the project's Storage tab, for **Production and Preview**, with
   preview branching on. Each preview deployment then gets its own database branch and
   `DATABASE_URL`. On Vercel, Neon's own variables are the **only** database source:
   `DATABASE_URL`, then `POSTGRES_URL` (`backend/src/config/databaseUrl.ts`). There is
   no localhost default, and Kubera's `DB_URL`/`DB_HOST` and the generic `PG*` are
   ignored. Without one of the two, the build fails with a message saying so.
3. **Set the environment variables** below.
4. **Turn on Deployment Protection** for previews (Vercel Authentication), so only team
   members can open a preview.

| Variable | Needed | Value |
|---|---|---|
| `SESSION_SECRET` | yes | 32+ random characters (`openssl rand -hex 32`) |
| `CRON_SECRET` | yes | random string; Vercel Cron sends it automatically |
| `DATABASE_URL` | yes | set by the Neon integration; never set by hand |
| `ENABLE_DEMO_LOGIN` | previews only | `true`, for the **Preview** environment only. Turns on the password sign-in form; ignored in production (see below). |
| `SEED_DEMO_PASSWORD` | previews only | 16+ characters, **Preview** only, type Sensitive. The password for the seeded demo accounts. Unset means every demo credential is revoked on the next deploy. |
| `SKIP_OIDC` | until Okta is set up | `true` (stops a failed discovery on every cold start) |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URL` | for sign-in | an Okta app whose redirect URI is `https://<domain>/auth/callback` |
| `BOOTSTRAP_SUPERADMIN_EMAILS` | optional | first sign-in by these addresses becomes superadmin |
| `CORS_ORIGIN` | optional | derived from the deployment's own URL when unset (`api/index.js`) |
| `EMAIL_SMTP_*`, `EMAIL_FROM` | optional | reminder and booking emails (use port 587) |
| `GOOGLE_OAUTH_*` | optional | Google Calendar connection |

## Not done yet

- **Real sign-in on previews.** Until Okta covers preview hostnames, previews use a
  **password sign-in** for the seeded demo accounts (`/auth/demo-login`; the Landing
  page's sign-in goes there):

  | Email | Role |
  |---|---|
  | `demo@example.com` | employee |
  | `demo2@example.com` | employee |
  | `admin@test.com` | researcher_admin |
  | `superadmin@test.com` | superadmin |

  - **Password.** The same one for all four: `SEED_DEMO_PASSWORD`, stored as a scrypt
    hash by `npm run seed` during each preview build (`demo_credentials` table). With no
    password seeded there are no credentials, and nobody can sign in.
  - **Where it exists.** It needs `ENABLE_DEMO_LOGIN=true` **and** Vercel's own
    `VERCEL_ENV=preview`, so production can never have it
    (`backend/src/services/demoCredentials.ts`, `routes/demoSignIn.ts`). The open,
    credential-less demo routes (`/auth/admin-login` and friends, Google demo mode) exist
    only under `NODE_ENV=development`.
  - **Checks.** The form post must come from the same origin. Wrong passwords go through
    the auth rate limiter. An unknown email costs the same scrypt run as a wrong password.
  - **The real fix** is an Okta app with redirect URIs covering the preview domain.
    Production needs the `OIDC_*` variables either way.
- **Recordings and artefact uploads (S3).** On Kubera the pod's IAM role (IRSA) granted S3.
  Vercel needs AWS OIDC federation to an IAM role and a bucket for this fork. Until then,
  FirstHand recording uploads fail.
- **Per-instance limits.** Rate limiting (`express-rate-limit`) and the FirstHand connection
  admission gate (`firsthand/runtime-pool-admission.ts`) count per function instance, not
  globally. Both were written for one long-lived process.
- **Database TLS.** Connections to Neon are encrypted but the certificate is not verified.
  `DB_TLS_VERIFY` expects the bundled RDS CA, and Neon's certificates chain to public
  roots, so verifying Neon means teaching `config/dbTls.ts` (and its parity twins) to use
  the system trust store.
- **CI.** None yet. See "Hosting and CI" in `AGENTS.md` for what to run before pushing.

## Checking it locally

```bash
npm ci --ignore-scripts && npm ci --prefix backend && npm ci --prefix frontend
DATABASE_URL=postgresql://postgres:password@localhost:5432/adaptalabs_dev \
SESSION_SECRET=$(openssl rand -hex 32) npx vercel build   # after `vercel link`; the same build Vercel runs
```
