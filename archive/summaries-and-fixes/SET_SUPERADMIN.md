# Set Superadmin Role

This guide helps you set your account (`nfine@adaptavist.com`) to the `superadmin` role so you can test the admin management functionality.

## Option 1: Using the Script (Recommended)

### For Local Development

```bash
# Make sure you have DATABASE_URL set in your environment
export DATABASE_URL="your-database-url"

# Run the script
node scripts/set-superadmin.js nfine@adaptavist.com
```

### For Vercel Production

1. **Get your DATABASE_URL from Vercel:**
   - Go to your Vercel project dashboard
   - Navigate to Settings → Environment Variables
   - Copy the `DATABASE_URL` value

2. **Run the script locally with the production DATABASE_URL:**
   ```bash
   DATABASE_URL="your-vercel-database-url" node scripts/set-superadmin.js nfine@adaptavist.com
   ```

## Option 2: Direct SQL Query

If you have direct database access, you can run this SQL:

```sql
-- First, update the role constraint to include superadmin
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check 
  CHECK (role IN ('employee', 'researcher_admin', 'superadmin'));

-- Then update your user
UPDATE users 
SET role = 'superadmin' 
WHERE email = 'nfine@adaptavist.com';
```

## Option 3: Using Vercel CLI

```bash
# Pull environment variables
vercel env pull .env.production

# Source the DATABASE_URL
export DATABASE_URL=$(grep DATABASE_URL .env.production | cut -d '=' -f2- | tr -d '"')

# Run the script
node scripts/set-superadmin.js nfine@adaptavist.com
```

## After Setting Superadmin

1. **Log out and log back in** to refresh your session
2. **Check your role** in the Header dropdown - it should show "Role: superadmin"
3. **Go to Settings** - you should see the "Admin Management" section
4. **Test the functionality:**
   - View all admins
   - View pending admin requests
   - Approve/deny requests
   - Revoke admin access

## Verification

After running the script, you can verify it worked by:

1. Checking the database:
   ```sql
   SELECT email, name, role FROM users WHERE email = 'nfine@adaptavist.com';
   ```
   Should show `role = 'superadmin'`

2. Logging out and back in, then checking the Header dropdown - should show "Role: superadmin"

## Troubleshooting

- **"User not found"**: Make sure the email is correct and the user exists in the database
- **"Constraint violation"**: The script will automatically update the constraint, but if it fails, run the SQL from Option 2 first
- **"Connection refused"**: Check that your DATABASE_URL is correct and accessible

