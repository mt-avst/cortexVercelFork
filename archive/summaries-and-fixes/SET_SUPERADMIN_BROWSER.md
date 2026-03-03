# Set Superadmin Role - Browser Method

The easiest way to set your account to superadmin is to use the API endpoint directly from your browser.

## Steps:

1. **Go to your production site**: https://adapta-labs-p62q.vercel.app (or your Vercel URL)

2. **Make sure you're logged in** as `nfine@adaptavist.com`

3. **Open browser console** (F12 or Cmd+Option+I)

4. **Paste and run this script**:

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
      // Optionally reload the page
      // window.location.reload();
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

5. **After running the script:**
   - You should see a success message
   - **Log out and log back in** to refresh your session
   - Check the Header dropdown - should show "Role: superadmin"
   - Go to Settings - you'll see the "Admin Management" section

## What the script does:

- Updates the database constraint to allow `superadmin` role
- Finds your user account
- Sets your role to `superadmin`
- Returns confirmation

## Troubleshooting:

- **"Authentication required"**: Make sure you're logged in
- **"Not authorized"**: The endpoint allows setting superadmin if you're already an admin, or if you're setting yourself (nfine@adaptavist.com)
- **"User not found"**: Make sure the email is correct

## After Setting:

Once you're superadmin, you can:
- View all admins in Settings → Admin Management
- Approve/deny admin requests
- Revoke admin access
- Manage the admin list

