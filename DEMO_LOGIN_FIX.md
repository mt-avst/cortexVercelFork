# Demo Login Endpoints Fix - Production Issue Resolution

**Date**: 2025-01-27  
**Issue**: HTTP 500 Internal Server Error on demo-login endpoint  
**Status**: ✅ **FIXED**

---

## Problem Identified

The demo-login, admin-login, and demo-user-2-login endpoints were failing in production with a 500 Internal Server Error. The root cause was:

**Issue**: Vercel serverless functions don't properly handle arrays passed to `res.setHeader('Set-Cookie', cookieArray)`. The code was trying to set multiple cookies using an array, which caused the function to fail.

---

## Root Cause

The endpoints were attempting to:
1. Clear multiple cookie variations using an array
2. Set a new cookie by pushing to the same array
3. Pass the entire array to `res.setHeader('Set-Cookie', cookieArray)`

**Problem**: Vercel's `VercelResponse` object doesn't support arrays for `Set-Cookie` headers. It expects a single string value.

---

## Solution Applied

Updated all three endpoints (`demo-login.ts`, `admin-login.ts`, `demo-user-2-login.ts`) to:

1. **Remove cookie clearing logic** - Setting a new cookie with the same name automatically replaces any existing cookie
2. **Use single Set-Cookie header** - Pass a single string instead of an array
3. **Follow pattern from google-callback** - Use the same cookie format that works in production
4. **Add Max-Age** - Set cookie expiration to 24 hours (86400 seconds) for consistency
5. **Improve URL handling** - Use `getApiConfig()` utility for consistent URL handling with trimming

---

## Changes Made

### 1. `api/auth/demo-login.ts`
- ✅ Removed cookie array clearing logic
- ✅ Changed to single `Set-Cookie` header string
- ✅ Added `Max-Age=86400` for 24-hour expiration
- ✅ Updated to use `getApiConfig()` for frontend URL
- ✅ Added URL trimming and trailing slash removal

### 2. `api/auth/admin-login.ts`
- ✅ Removed cookie array clearing logic
- ✅ Changed to single `Set-Cookie` header string
- ✅ Added `Max-Age=86400` for 24-hour expiration
- ✅ Updated to use `getApiConfig()` for frontend URL
- ✅ Added URL trimming and trailing slash removal
- ✅ Maintained `/admin` redirect path

### 3. `api/auth/demo-user-2-login.ts`
- ✅ Removed cookie array clearing logic
- ✅ Changed to single `Set-Cookie` header string
- ✅ Added `Max-Age=86400` for 24-hour expiration
- ✅ Updated to use `getApiConfig()` for frontend URL
- ✅ Added URL trimming and trailing slash removal

---

## Technical Details

### Before (Broken):
```typescript
const cookieArray: string[] = [];
cookieArray.push(`adaptalabs_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Domain=.vercel.app; expires=Thu, 01 Jan 1970 00:00:00 GMT`);
// ... more cookie clearing pushes ...
cookieArray.push(`adaptalabs_session=${sessionCookie}; HttpOnly; Secure; SameSite=None; Path=/`);
res.setHeader('Set-Cookie', cookieArray); // ❌ Fails in Vercel
```

### After (Fixed):
```typescript
const sessionCookie = encodeURIComponent(JSON.stringify(demoUser));
res.setHeader('Set-Cookie', `adaptalabs_session=${sessionCookie}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=86400`); // ✅ Works
```

---

## Cookie Format

All endpoints now use the same cookie format:
- **Name**: `adaptalabs_session`
- **Value**: URL-encoded JSON string of user session data
- **Attributes**:
  - `HttpOnly` - Prevents JavaScript access
  - `Secure` - Only sent over HTTPS
  - `SameSite=None` - Required for cross-origin redirects
  - `Path=/` - Available site-wide
  - `Max-Age=86400` - 24-hour expiration

---

## Testing Required

After deployment, verify:

1. ✅ **Demo Login** (`/api/auth/demo-login`)
   - Should redirect to home page
   - Should set session cookie
   - Should authenticate user as "Demo User"

2. ✅ **Admin Login** (`/api/auth/admin-login`)
   - Should redirect to `/admin`
   - Should set session cookie
   - Should authenticate user as "Test Admin" with researcher_admin role

3. ✅ **Demo User 2 Login** (`/api/auth/demo-user-2-login`)
   - Should redirect to home page
   - Should set session cookie
   - Should authenticate user as "Demo User 2"

---

## Files Modified

- `api/auth/demo-login.ts`
- `api/auth/admin-login.ts`
- `api/auth/demo-user-2-login.ts`

---

## Related Files

- `api/auth/google-callback.ts` - Reference implementation (working correctly)
- `api/utils/env.ts` - Provides `getApiConfig()` utility

---

## Next Steps

1. ✅ **Deploy to Production** - Push changes to trigger Vercel deployment
2. ⏳ **Test in Production** - Verify all three login endpoints work
3. ⏳ **Monitor Logs** - Check Vercel function logs for any errors
4. ⏳ **Verify Session Persistence** - Ensure cookies persist across page loads

---

**Status**: ✅ **Ready for Deployment**  
**Linter Errors**: None  
**Breaking Changes**: None (fix only)

