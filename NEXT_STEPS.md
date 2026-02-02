# Next Steps - Recommended Action Plan

## Current Status ✅
- **M6 (Polls & Surveys)**: Core functionality implemented ✅
- **M5 (Calendar)**: Dynamic availability working ✅
- **Vercel Deployment**: Production deployed ✅
- **Browser Testing**: Core features verified ✅

## Priority 1: Fix Known Issues 🔧

### 1. Fix Edit Opportunity GET Handler ✅ Verified
**Status**: Already correct. `api/opportunities/[id].ts` GET handler allows admins (`isAdmin = researcher_admin || superadmin`) to load any opportunity including drafts; non-admins get 404 for non-published. No change needed.

### 2. Fix Logout Endpoint ✅ Done
**Status**: `api/auth/logout.ts` exists; vercel.json rewrites `/auth/logout` → `/api/auth/logout`. Handler now accepts both GET and POST so redirects/links to logout URL work; frontend continues to use POST.

## Priority 2: Complete M6 Testing 📊

### 3. End-to-End Click Tracking Test
**Steps**:
1. Publish the test poll (change status from draft to published)
2. Log in as demo user (not admin)
3. Navigate to poll opportunity detail page
4. Click "Open Poll" button
5. Verify click is tracked in database
6. Check admin dashboard - clicks should increment
7. Test analytics dashboard in edit form

### 4. Analytics Dashboard Verification
**Test**:
- Edit published poll/survey
- Navigate to analytics section
- Verify:
  - Total clicks display
  - 24-hour clicks count
  - 30-day trend chart
  - Empty state (no clicks yet)

## Priority 3: Production Readiness 🚀

### 5. Error Handling & Edge Cases
- [ ] Test with multiple users clicking same poll
- [ ] Test analytics with 0 clicks, 1 click, multiple clicks
- [ ] Verify IP hashing is working (privacy check)
- [ ] Test poll/survey validation (external link required)

### 6. Code Cleanup
- [x] Replace console with logger in main API routes (feedback, sessions, click, feedback export/delete); admin/reset scripts left as-is for operational visibility
- [x] Error boundary already present (frontend App wrapped in ErrorBoundary)
- [ ] Verify all environment variables are set in Vercel

### 7. Documentation
- [ ] Update README with M6 features
- [ ] Document analytics API endpoints
- [ ] Create user guide for polls/surveys

## Priority 4: Next Milestones 🎯

### Option A: M7 - Dashboard & Settings
- Enhanced user dashboard
- Profile settings
- Notification preferences
- Usage statistics

### Option B: Production Hardening
- Performance optimization
- Security audit
- Load testing
- Backup strategy

### Option C: Feature Enhancements
- Email notifications
- Reminder system
- Advanced analytics (export data)
- Multi-language support

## Recommended Immediate Action Plan

**This Week:**
1. ✅ Fix edit opportunity GET handler — verified correct
2. ✅ Fix logout endpoint — GET support added
3. ✅ Complete M6 end-to-end testing (see E2E_PLAYWRIGHT_RUN_2026-02-02.md)
4. ✅ Verify analytics dashboard (passed in E2E)

**Next Week:**
5. Production hardening
6. Error handling improvements
7. Documentation updates
8. Decide on M7 vs. enhancements

## Quick Wins (Today)
- Fix the two known issues (20 min total)
- Complete click tracking test (30 min)
- Verify analytics works end-to-end

## Questions to Consider
1. **Is M6 considered complete?** Or do you need more features?
2. **Priority**: Fix issues first, or move to M7?
3. **Production readiness**: Are you ready to launch, or need more testing?

---

**Recommendation**: Start with Priority 1 (fix the two issues), then complete Priority 2 (M6 testing). This will give you a fully functional M6 milestone and a stable production deployment.


