# Run Database Reset Now

**Quick instructions to reset the database on Vercel**

---

## ⚠️ Important: Deploy First

The new endpoint needs to be deployed to Vercel first. Here are your options:

---

## Option 1: Use Existing Endpoint (Works Now)

The existing endpoint works immediately but **doesn't create sessions**:

### Steps:
1. Go to: https://adapta-labs-p62q.vercel.app
2. Sign in as admin
3. Open browser console (F12)
4. Paste this:

```javascript
fetch('/api/admin/reset-demo-data', { 
  method: 'POST', 
  credentials: 'include' 
})
  .then(res => res.json())
  .then(data => {
    console.log('✅ Reset complete!', data);
    alert('Database reset complete! Created ' + data.created.total + ' opportunities (no sessions).');
    window.location.reload();
  })
  .catch(err => {
    console.error('❌ Error:', err);
    alert('Reset failed. Check console.');
  });
```

**Result**: Creates 6 opportunities WITHOUT sessions

---

## Option 2: Deploy New Endpoint First (Recommended)

To get sessions, deploy the new endpoint first:

### Step 1: Commit and Push

```bash
git add api/admin/reset-demo-data-with-sessions.ts
git commit -m "Add database reset endpoint with sessions"
git push
```

### Step 2: Wait for Vercel Deployment

- Check Vercel dashboard
- Wait for deployment to complete (1-2 minutes)

### Step 3: Run Reset

1. Go to: https://adapta-labs-p62q.vercel.app
2. Sign in as admin
3. Open browser console (F12)
4. Paste this:

```javascript
fetch('/api/admin/reset-demo-data-with-sessions', { 
  method: 'POST', 
  credentials: 'include' 
})
  .then(res => res.json())
  .then(data => {
    if (data.success) {
      console.log('✅ Reset complete!', data);
      alert('Database reset complete!\n\n' +
            'Created:\n' +
            '- ' + data.created.opportunities.total + ' opportunities\n' +
            '- ' + data.sessions_created + ' sessions');
      window.location.reload();
    } else {
      console.error('❌ Failed:', data);
      alert('Reset failed: ' + (data.error || data.message));
    }
  })
  .catch(err => {
    console.error('❌ Error:', err);
    if (err.message.includes('404') || err.message.includes('Not Found')) {
      alert('Endpoint not found. The new endpoint may not be deployed yet.\n\n' +
            'Please deploy first or use the existing endpoint.');
    } else {
      alert('Network error. Check console.');
    }
  });
```

**Result**: Creates 6 opportunities WITH 60 sessions

---

## Option 3: Smart Script (Tries Both)

This script tries the new endpoint first, falls back to the existing one:

```javascript
(async function resetDatabase() {
  console.log('🔄 Starting database reset...');
  
  // Try new endpoint first (with sessions)
  try {
    console.log('📡 Trying new endpoint (with sessions)...');
    const response = await fetch('/api/admin/reset-demo-data-with-sessions', {
      method: 'POST',
      credentials: 'include'
    });
    
    if (response.ok) {
      const data = await response.json();
      if (data.success) {
        console.log('✅ Reset complete with sessions!', data);
        alert('✅ Database Reset Complete!\n\n' +
              'Created:\n' +
              '- ' + data.created.opportunities.total + ' opportunities\n' +
              '- ' + data.sessions_created + ' sessions\n\n' +
              'Page will refresh...');
        setTimeout(() => window.location.reload(), 2000);
        return;
      }
    }
  } catch (err) {
    console.log('⚠️ New endpoint not available, trying existing endpoint...');
  }
  
  // Fallback to existing endpoint (without sessions)
  try {
    console.log('📡 Using existing endpoint (without sessions)...');
    const response = await fetch('/api/admin/reset-demo-data', {
      method: 'POST',
      credentials: 'include'
    });
    
    const data = await response.json();
    if (data.success) {
      console.log('✅ Reset complete (no sessions)!', data);
      alert('✅ Database Reset Complete!\n\n' +
            'Created ' + data.created.total + ' opportunities.\n' +
            'Note: No sessions created (using existing endpoint).\n\n' +
            'To get sessions, deploy the new endpoint first.\n\n' +
            'Page will refresh...');
      setTimeout(() => window.location.reload(), 2000);
    } else {
      throw new Error(data.error || data.message);
    }
  } catch (err) {
    console.error('❌ Reset failed:', err);
    alert('❌ Reset failed: ' + err.message + '\n\n' +
          'Make sure you are:\n' +
          '1. Signed in as admin\n' +
          '2. On the production site');
  }
})();
```

---

## 🎯 Quick Decision

**Want sessions?** → Deploy first (Option 2)  
**Just need opportunities?** → Use existing endpoint now (Option 1)  
**Not sure?** → Use smart script (Option 3)

---

**Ready to run?** Copy one of the scripts above and paste into your browser console!

