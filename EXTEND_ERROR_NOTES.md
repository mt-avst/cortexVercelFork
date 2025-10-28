# "extend is not a function" Error Investigation

## Problem
When editing an opportunity in admin mode, the error "extend is not a function" occurs on the session management page.

## Changes Made

### 1. Removed Duplicate State Declarations
In `frontend/src/components/AdminSessionManager.tsx`:
- Removed duplicate state declarations for `loading`, `error`, `isUpdating`, `showResetConfirmation`, and `viewMode`
- Moved `viewMode` state declaration before the `useEffect` that uses it

### 2. Fixed State Declaration Order
The states are now declared in this order:
```typescript
const [selectedSlots, setSelectedSlots] = useState<Set<string>>(getStoredSelectedSlots);
const [confirmedSlots, setConfirmedSlots] = useState<Set<string>>(getStoredConfirmedSlots);

// Calendar view mode
const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');

const [loading, setLoading] = useState(false);
const [error, setError] = useState<string>('');
const [isUpdating, setIsUpdating] = useState(false);
const [showResetConfirmation, setShowResetConfirmation] = useState(false);
```

## Possible Causes of Persistent Error

1. **Browser Cache**: The old compiled code may still be cached in the browser
2. **Build Cache**: TypeScript/React build cache may need clearing
3. **Browser Extension**: A browser extension (e.g., React DevTools) might be causing the error

## Next Steps to Debug

1. Clear browser cache completely (Ctrl+Shift+Delete)
2. Hard refresh the page (Ctrl+Shift+R or Cmd+Shift+R)
3. Check browser console for exact error message and stack trace
4. Try in incognito/private mode to rule out extensions
5. Check if error occurs in development mode vs production mode

## Testing

To test if the fix works:
1. Restart frontend: `cd frontend && npm start`
2. Login as admin
3. Edit an existing test or interview study
4. Navigate to the Session Management tab
5. Check browser console for errors


