# Set researcher_admin (Admin) Role

To add Chelsea Howard and Greta Baisch (or any user) as **Admin** (researcher_admin):

1. **They must have logged in at least once** (e.g. with Google) so their user exists in the database.

2. **Get your production database URL** from Vercel:
   - Vercel Dashboard → your project → Settings → Environment Variables  
   - Copy `DATABASE_URL` or `POSTGRES_URL` (Production).  
   Or run: `vercel env pull .env.production` (then use the URL from `.env.production`).

3. **Run the script** from the repo root:

   ```bash
   DATABASE_URL="your-production-database-url" npx ts-node --transpile-only scripts/set-researcher-admin.ts choward@adaptavist.com gbaisch@adaptavist.com
   ```

   Or if you have `.env.production` with `DATABASE_URL`:

   ```bash
   set -a && source .env.production && set +a && npx ts-node --transpile-only scripts/set-researcher-admin.ts choward@adaptavist.com gbaisch@adaptavist.com
   ```

4. **They should log out and log back in** so their session picks up the new role.

To add more admins later, append their emails:

```bash
DATABASE_URL="..." npx ts-node --transpile-only scripts/set-researcher-admin.ts email1@example.com email2@example.com
```
