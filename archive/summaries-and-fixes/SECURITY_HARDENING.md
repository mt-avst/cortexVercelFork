# Security Hardening Summary

This document describes the security improvements made to AdaptaLabs and provides guidance for ongoing security maintenance.

## Completed Security Improvements

### 1. Session Cookie Security
- **HMAC-SHA256 Signed Cookies**: Session cookies are now cryptographically signed to prevent tampering
- **HttpOnly Flag**: Cookies cannot be accessed by JavaScript
- **Secure Flag**: Cookies only transmitted over HTTPS (in production)
- **SameSite=Lax**: Provides CSRF protection for most scenarios

### 2. Token Encryption
- **AES-256-GCM Encryption**: OAuth tokens are encrypted with authenticated encryption
- **Replaced XOR Cipher**: Legacy weak encryption has been replaced
- **Key Derivation**: Uses environment variable `ENCRYPTION_KEY`

### 3. OAuth Security
- **State Parameter Validation**: CSRF protection for OAuth flows
- **Signed State Tokens**: State includes timestamp and HMAC signature
- **Expiry Checking**: State tokens expire after 10 minutes

### 4. API Authorization
- **Ownership Checks**: PATCH/DELETE operations verify resource ownership
- **Role-Based Access**: Admin operations require appropriate roles
- **403 Forbidden**: Unauthorized access attempts are properly rejected

### 5. SQL Injection Prevention
- **Table Name Whitelisting**: Dynamic table names are validated against whitelist
- **Parameterized Queries**: All user input is parameterized

### 6. Email Template Security
- **HTML Escaping**: User-provided content is escaped before embedding in emails
- **XSS Prevention**: Prevents injection attacks via email templates

### 7. Security Headers
- **X-Content-Type-Options**: nosniff
- **X-Frame-Options**: DENY (prevents clickjacking)
- **X-XSS-Protection**: 1; mode=block
- **Referrer-Policy**: strict-origin-when-cross-origin
- **Permissions-Policy**: Restricts camera, microphone, geolocation
- **Cache-Control**: no-store for API responses

### 8. Rate Limiting
- **Auth Endpoints**: 10 requests per 15 minutes per IP
- **Brute Force Protection**: Prevents password/token guessing attacks

### 9. Secret Management
- **Environment Variables**: Secrets stored in Vercel, not in code
- **Git Ignore**: All .env files excluded from version control
- **Secrets Removed**: Previously exposed secrets removed from git history

---

## Required Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `SESSION_SECRET` | 32+ character secret for HMAC signing | `kR7xmP2sL9vQ4wN8tB3yF6hJ1cD5aG0e` |
| `ENCRYPTION_KEY` | 64-character hex key (32 bytes) for AES-256-GCM | `9f3a8b7c6d5e...` |
| `GOOGLE_OAUTH_CLIENT_SECRET` | OAuth client secret from Google Cloud Console | `GOCSPX-...` |

---

## Google OAuth Client Secret Rotation

Since the OAuth client secret was previously exposed in git (even though the repo is private), it's recommended to rotate it:

### Steps to Rotate:

1. **Go to Google Cloud Console**
   - Navigate to: https://console.cloud.google.com/apis/credentials
   - Select your project

2. **Create New Secret**
   - Click on your OAuth 2.0 Client ID
   - Under "Client secrets", click "Add Secret"
   - Copy the new secret value

3. **Update Vercel Environment Variable**
   - Go to: https://vercel.com/[your-team]/adapta-labs-p62q/settings/environment-variables
   - Update `GOOGLE_OAUTH_CLIENT_SECRET` with the new value
   - Save changes

4. **Redeploy Application**
   - Trigger a new deployment for changes to take effect

5. **Delete Old Secret**
   - Back in Google Cloud Console, delete the old secret
   - Click the trash icon next to the old secret

6. **Verify**
   - Test Google OAuth login to ensure it still works

### Important Notes:
- Do this during low-traffic periods
- Have the new secret ready before deleting the old one
- Test immediately after deployment

---

## Token Migration

If you have users with OAuth tokens encrypted using the old XOR cipher, run the migration script:

```bash
# Dry run (no changes made)
DATABASE_URL=... ENCRYPTION_KEY=... GOOGLE_OAUTH_CLIENT_SECRET=... \
  npx ts-node scripts/migrate-tokens.ts --dry-run

# Actual migration
DATABASE_URL=... ENCRYPTION_KEY=... GOOGLE_OAUTH_CLIENT_SECRET=... \
  npx ts-node scripts/migrate-tokens.ts
```

---

## Security Checklist for Future Development

- [ ] Always use parameterized queries for database operations
- [ ] Validate and sanitize all user input
- [ ] Use the `parseSessionCookie()` function to verify authentication
- [ ] Check authorization (ownership/role) before modifying resources
- [ ] Escape user content in email templates using `escapeHtml()`
- [ ] Never log sensitive data (passwords, tokens, secrets)
- [ ] Add rate limiting to new sensitive endpoints
- [ ] Review security headers when adding new routes

---

## Reporting Security Issues

If you discover a security vulnerability, please report it privately to the development team rather than opening a public issue.
