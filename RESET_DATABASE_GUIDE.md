# Database Reset Guide

**How to reset the database and repopulate with fresh demo content**

---

## 🎯 Quick Options

### Option 1: Reset with Sessions (Recommended for Alpha Testing)

**Creates opportunities WITH sessions** - Ready for booking immediately.

**Via API (Production/Vercel)**:
```bash
# From browser console when logged in as admin:
fetch('/api/admin/reset-demo-data-with-sessions', { 
  method: 'POST', 
  credentials: 'include' 
})
  .then(res => res.json())
  .then(data => console.log('✅ Reset complete:', data));
```

**What it creates**:
- ✅ 6 opportunities (2 test, 2 poll, 2 survey)
- ✅ 60 sessions total (spread across next week)
- ✅ All published and ready for booking
- ✅ All bookings cleared

---

### Option 2: Reset without Sessions (Clean Slate)

**Creates opportunities WITHOUT sessions** - For clearing all slots.

**Via API (Production/Vercel)**:
```bash
# From browser console when logged in as admin:
fetch('/api/admin/reset-demo-data', { 
  method: 'POST', 
  credentials: 'include' 
})
  .then(res => res.json())
  .then(data => console.log('✅ Reset complete:', data));
```

**What it creates**:
- ✅ 6 opportunities (2 test, 2 poll, 2 survey)
- ❌ No sessions (all slots cleared)
- ✅ All published
- ✅ All bookings cleared

---

## 📋 What Gets Reset

### Deleted:
- ✅ All bookings
- ✅ All sessions
- ✅ All opportunities

### Created (with sessions):
- **2 Test Opportunities**:
  - User Interface Testing (15 sessions - Mon-Fri, 10am/2pm/3pm)
  - New Feature Validation (9 sessions - Mon/Wed/Fri, 10am/2pm/3pm)

- **2 Poll Opportunities**:
  - Work-Life Balance Survey (15 sessions - Mon-Fri, 10am/2pm/3pm)
  - Remote Work Preferences (6 sessions - Tue/Thu, 10am/2pm/3pm)

- **2 Survey Opportunities**:
  - Employee Engagement Survey (9 sessions - Mon/Wed/Fri, 10am/2pm/3pm)
  - Product Feedback Survey (6 sessions - Tue/Thu, 10am/2pm/3pm)

**Total**: 6 opportunities, 60 sessions

---

## 🚀 How to Use

### Step 1: Sign In as Admin

1. Go to https://adapta-labs-p62q.vercel.app
2. Sign in as admin (use demo admin login or your admin account)

### Step 2: Open Browser Console

- **Chrome/Edge**: Press `F12` or `Ctrl+Shift+J` (Windows) / `Cmd+Option+J` (Mac)
- **Firefox**: Press `F12` or `Ctrl+Shift+K` (Windows) / `Cmd+Option+K` (Mac)
- **Safari**: Enable Developer menu first, then `Cmd+Option+C`

### Step 3: Run Reset Command

**For sessions (recommended)**:
```javascript
fetch('/api/admin/reset-demo-data-with-sessions', { 
  method: 'POST', 
  credentials: 'include' 
})
  .then(res => res.json())
  .then(data => {
    console.log('✅ Reset complete!');
    console.log('Created:', data.created);
    console.log('Sessions:', data.sessions_created);
    alert('Database reset complete! Refresh the page to see new opportunities.');
  })
  .catch(err => {
    console.error('❌ Error:', err);
    alert('Reset failed. Check console for details.');
  });
```

**Without sessions**:
```javascript
fetch('/api/admin/reset-demo-data', { 
  method: 'POST', 
  credentials: 'include' 
})
  .then(res => res.json())
  .then(data => {
    console.log('✅ Reset complete!');
    console.log('Created:', data.created);
    alert('Database reset complete! Refresh the page to see new opportunities.');
  })
  .catch(err => {
    console.error('❌ Error:', err);
    alert('Reset failed. Check console for details.');
  });
```

### Step 4: Verify

1. Refresh the page
2. Check Admin Dashboard - should show 6 opportunities
3. Check Home page - should show 6 opportunities
4. Click on an opportunity - should show sessions (if using with-sessions version)

---

## 🔧 Alternative: Backend Script (Local Development)

If running locally:

```bash
cd backend
npm run reset-demo
```

This uses `backend/src/db/reset-demo-data.ts` which creates opportunities WITH sessions.

---

## ⚠️ Important Notes

### Authentication Required
- Must be logged in as admin
- Must have `researcher_admin` role
- API will return 403 if not admin

### Data Loss Warning
- **All existing data will be deleted**
- This includes:
  - All bookings
  - All sessions
  - All opportunities
- **This cannot be undone!**

### Session Timing
- Sessions are created for **next week** (Monday-Friday)
- Times: 10am, 2pm, 3pm
- Capacity: 5 participants per session
- All sessions are in the future

---

## 🐛 Troubleshooting

### "Authentication required" Error
- Make sure you're logged in
- Check you're using an admin account
- Try logging out and back in

### "Admin access required" Error
- Your account doesn't have admin role
- Use demo admin login or contact support

### No Sessions Created
- Check which endpoint you used
- `/reset-demo-data` = no sessions
- `/reset-demo-data-with-sessions` = with sessions

### Sessions Not Showing
- Refresh the page
- Check opportunity is published
- Verify sessions are in the future (not past)

---

## 📊 Expected Results

After reset with sessions:
- **6 opportunities** visible on home page
- **60 sessions** total across all opportunities
- **0 bookings** (fresh start)
- All opportunities **published** and ready

---

## ✅ Success Indicators

You'll know it worked when:
1. ✅ Console shows success message
2. ✅ Response includes `success: true`
3. ✅ Shows counts of created items
4. ✅ Page refresh shows new opportunities
5. ✅ Admin dashboard shows 6 opportunities

---

**Last Updated**: 2025-01-27  
**Version**: 7.3.23

