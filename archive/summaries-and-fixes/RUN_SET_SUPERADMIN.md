# Set Superadmin Role - Quick Guide

## ✅ Code is Deployed!

The superadmin system has been deployed to Vercel. Now you need to set your account to superadmin.

## 🚀 Easiest Method: Browser Console

1. **Go to your production site**: https://adapta-labs-p62q.vercel.app
2. **Make sure you're logged in** as `nfine@adaptavist.com`
3. **Open browser console** (F12 or Cmd+Option+I on Mac)
4. **Paste and run this code**:

```javascript
fetch('/api/admin/set-superadmin', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  credentials: 'include',
  body: JSON.stringify({
    email: 'nfine@adaptavist.com'
  })
})
  .then(res => res.json())
  .then(data => {
    if (data.success) {
      console.log('✅ Success!', data);
      alert(`✅ Superadmin role set!\n\n${data.message}\n\n${data.note}`);
    } else {
      console.error('❌ Failed:', data);
      alert('Failed: ' + (data.error || data.message));
    }
  })
  .catch(err => {
    console.error('Error:', err);
    alert('Error: ' + err.message);
  });
```

5. **After you see the success message:**
   - Log out and log back in (to refresh your session)
   - Check the Header dropdown - should show "Role: superadmin"
   - Go to Settings → you'll see the "Admin Management" section

## ✅ Verification

After logging back in:
- Header dropdown shows: "Role: superadmin"
- Settings page has "Admin Management" section
- You can view all admins, approve/deny requests, and revoke access

## 🎉 Done!

You're now superadmin and can test the full admin management system!

