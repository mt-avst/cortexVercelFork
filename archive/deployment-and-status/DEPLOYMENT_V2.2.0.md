# Deployment Guide: Version 2.2.0 (M6 Polls & Surveys)

**Date**: 2025-01-15  
**Version**: 2.2.0  
**Milestone**: M6 - Polls and Surveys Click Tracking

## Changes in This Release

### ✅ New Features (M6)
- Click tracking for polls and surveys
- Analytics dashboard for opportunity owners
- Admin dashboard shows click counts for polls/surveys
- Privacy-aware IP hashing for click tracking

### ✅ New API Endpoints
- `POST /api/opportunities/[id]/click` - Track poll/survey clicks (optional auth)
- `GET /api/opportunities/[id]/analytics` - Get click analytics (admin only)

### ✅ Database Changes
- New table: `opportunity_clicks`
- Indexes added for performance

### ✅ Frontend Updates
- Click tracking on "Open Poll/Survey" buttons
- Analytics display in admin edit page
- Click counts column in admin dashboard

### ✅ Backend Updates
- Proxy trust configuration for accurate IP tracking
- Updated opportunities list to include click counts for admins

---

## Pre-Deployment Checklist

### ✅ Version Numbers Updated
- [x] Root package.json: `2.1.0` → `2.2.0`
- [x] Backend package.json: `2.1.0` → `2.2.0`
- [x] Frontend package.json: `2.1.0` → `2.2.0`

### ✅ Code Review Complete
- [x] Code review document created: `CODE_REVIEW_M6.md`
- [x] No linting errors
- [x] Type safety verified

### ✅ New Serverless Functions Created
- [x] `api/opportunities/[id]/click.ts`
- [x] `api/opportunities/[id]/analytics.ts`
- [x] `api/opportunities.ts` updated with click counts

---

## Database Migration Required

**⚠️ IMPORTANT**: Run database migration before deploying!

```bash
# In production database
cd backend
npm run migrate
```

This will create the `opportunity_clicks` table and indexes.

---

## Vercel Deployment

### Option 1: Git Push (Recommended)
If Vercel Git integration is enabled:

```bash
git add .
git commit -m "chore: version bump to 2.2.0 - M6 Polls & Surveys implementation"
git push origin main  # or your main branch
```

Vercel will automatically deploy on push.

### Option 2: Vercel CLI
If you have Vercel CLI installed:

```bash
vercel deploy --prod
```

### Option 3: Vercel Dashboard
1. Go to https://vercel.com/dashboard
2. Select project: `adapta-labs-p62q`
3. Click "Deploy" → "Deploy latest commit"
   OR
   Connect to Git and push to trigger automatic deployment

---

## Environment Variables Required

Ensure these are set in Vercel project settings:

### Required
- `DATABASE_URL` or `POSTGRES_URL` - PostgreSQL connection string
- `SESSION_SECRET` - For session encryption and IP hashing

### Recommended
- `TRUST_PROXY` - Set to `true` if behind reverse proxy (default: true)
- `NODE_ENV` - `production`
- `CORS_ORIGIN` - Frontend URL
- All other existing environment variables

---

## Post-Deployment Verification

### 1. Database Migration
```sql
-- Verify table exists
SELECT * FROM information_schema.tables 
WHERE table_name = 'opportunity_clicks';

-- Verify indexes
SELECT indexname FROM pg_indexes 
WHERE tablename = 'opportunity_clicks';
```

### 2. API Endpoints
Test the new endpoints:
```bash
# Click tracking (should work without auth)
curl -X POST https://your-vercel-url.vercel.app/api/opportunities/{id}/click

# Analytics (requires auth)
curl -X GET https://your-vercel-url.vercel.app/api/opportunities/{id}/analytics \
  -H "Cookie: adaptalabs_session=..."
```

### 3. Frontend Functionality
1. ✅ Admin dashboard shows "Clicks" column
2. ✅ Poll/Survey detail pages have "Open Poll/Survey" button
3. ✅ Clicking button tracks click and opens external link
4. ✅ Admin edit page shows analytics section
5. ✅ Analytics display total, 24h, and 30-day trends

---

## Rollback Plan

If issues occur:

1. **Revert via Git**:
   ```bash
   git revert HEAD
   git push origin main
   ```

2. **Rollback Deployment in Vercel Dashboard**:
   - Go to project → Deployments
   - Find previous working deployment
   - Click "..." → "Promote to Production"

3. **Database Rollback** (if needed):
   ```sql
   DROP TABLE IF EXISTS opportunity_clicks CASCADE;
   ```

---

## Project Information

- **Vercel Project**: `adapta-labs-p62q`
- **Project ID**: `prj_CRUL0hc7A1ZWUWhpKoIcLfo6Vb7i`
- **Team ID**: `team_boepIglpUNQ18ZugKgnTrHwg`
- **Domains**:
  - `adapta-labs-p62q.vercel.app`
  - `adapta-labs-p62q-nicks-projects-113886a0.vercel.app`

---

## Files Changed

### New Files
- `api/opportunities/[id]/click.ts`
- `api/opportunities/[id]/analytics.ts`
- `CODE_REVIEW_M6.md`
- `DEPLOYMENT_V2.2.0.md` (this file)

### Modified Files
- `package.json` (version bump)
- `backend/package.json` (version bump)
- `frontend/package.json` (version bump)
- `backend/src/routes/opportunities.ts` (M6 endpoints)
- `backend/src/db/migrate.ts` (opportunity_clicks table)
- `backend/src/index.ts` (proxy trust config)
- `frontend/src/api/client.ts` (click tracking functions)
- `frontend/src/pages/OpportunityDetail.tsx` (click tracking UI)
- `frontend/src/pages/Admin.tsx` (clicks column)
- `frontend/src/pages/OpportunityForm.tsx` (analytics display)
- `shared/types/index.ts` (clicks_total field)
- `frontend/src/shared/types.ts` (clicks_total field)
- `api/opportunities.ts` (click counts in list)

---

## Next Steps

1. ✅ Run database migration on production database
2. ✅ Deploy to Vercel (via Git push or CLI)
3. ✅ Verify deployment in Vercel dashboard
4. ✅ Test new endpoints
5. ✅ Verify frontend functionality

**Ready for deployment!** 🚀


