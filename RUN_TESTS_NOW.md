# Run End-to-End Tests Now

**Quick Start Guide for Testing**

---

## 🚀 Quick Start

### Option 1: Run Smoke Tests (Fast - 2 minutes)

```bash
npm run test:smoke
```

This runs basic smoke tests against production to verify the site is working.

### Option 2: Manual Testing (Recommended - 30-60 minutes)

Follow the step-by-step guide in **`TESTING_GUIDE.md`** or **`END_TO_END_TESTING_CHECKLIST.md`**

### Option 3: Full Automated Tests (If local dev running)

```bash
npm run test:e2e
```

**Note**: This requires local dev servers running.

---

## 📋 What to Test

### Critical Flows (Must Test)

1. **New User Journey** (15 min)
   - Browse → Login → Book → Verify

2. **Booking Flow** (10 min)
   - Sign in → Book session → Check My Bookings

3. **Cancel Booking** (5 min)
   - Cancel booking → Verify slot available

4. **Reschedule** (5 min)
   - Reschedule booking → Verify both bookings

5. **Admin Create** (10 min)
   - Create opportunity → Publish → Verify public

6. **Poll/Survey Tracking** (5 min)
   - Click poll → Verify analytics

**Total Time**: ~50 minutes

---

## ✅ Test Results

After testing, document results:

1. **What worked**: ✅
2. **What failed**: ❌
3. **Issues found**: List all issues
4. **Recommendation**: Ready for alpha? Yes/No

---

## 🐛 Found Issues?

1. Document in `KNOWN_ISSUES.md`
2. Use feedback form to report
3. Prioritize fixes:
   - Critical (blocking) → Fix immediately
   - Medium → Fix before alpha
   - Low → Fix later

---

## 📝 Next Steps

After testing:

- [ ] Review all test results
- [ ] Fix critical bugs
- [ ] Update known issues document
- [ ] Make go/no-go decision for alpha

---

**Ready to test?** Start with `TESTING_GUIDE.md` or run `npm run test:smoke`

