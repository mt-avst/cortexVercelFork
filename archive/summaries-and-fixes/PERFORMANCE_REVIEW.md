# Performance Review Report

**Date**: 2025-01-27  
**Reviewer**: AI Assistant  
**Scope**: Full codebase performance analysis

---

## Executive Summary

This review identified **8 critical performance issues** and **5 optimization opportunities** that could significantly improve application performance, especially under load. The most critical issues are N+1 query problems that can cause exponential query growth as data scales.

---

## 🔴 Critical Performance Issues

### 1. N+1 Query Problem in Opportunities List Endpoint

**Location**: 
- `api/opportunities.ts` (lines 110-173)
- `backend/src/routes/opportunities.ts` (lines 146-177)

**Issue**: When listing opportunities, the code:
1. Queries all opportunities (1 query)
2. For each opportunity, queries sessions (N queries)
3. For each poll/survey (if admin), queries click counts (M queries)

**Impact**: 
- For 50 opportunities with 10 sessions each: **1 + 50 + M = 51+ queries**
- Response time grows linearly with number of opportunities
- Database connection pool exhaustion under load

**Current Code Pattern**:
```typescript
const opportunities = await Promise.all(
  result.rows.map(async (opp) => {
    // Query 1: Sessions for this opportunity
    const sessionsResult = await query(`SELECT ... WHERE opportunity_id = $1`, [opp.id]);
    
    // Query 2: Click count (if poll/survey)
    if ((opp.type === 'poll' || opp.type === 'survey') && isAdmin) {
      const clicksResult = await query(`SELECT COUNT(*) ... WHERE opportunity_id = $1`, [opp.id]);
    }
  })
);
```

**Recommended Fix**: Use JOINs and aggregate queries:
```typescript
// Single query to get all opportunities with session counts
const result = await query(`
  SELECT 
    o.*,
    u.name as owner_name,
    u.email as owner_email,
    COUNT(DISTINCT s.id) as session_count,
    -- Use subquery or JOIN for click counts
    (SELECT COUNT(*) FROM opportunity_clicks oc 
     WHERE oc.opportunity_id = o.id) as clicks_total
  FROM opportunities o
  LEFT JOIN users u ON o.owner_user_id = u.id
  LEFT JOIN sessions s ON s.opportunity_id = o.id
  WHERE ...
  GROUP BY o.id, u.name, u.email
  ORDER BY o.created_at DESC
`);

// Then optionally load full session details only for selected opportunities
// Or use a separate single query to get all sessions at once:
const allSessions = await query(`
  SELECT s.*, 
    COALESCE(COUNT(b.id) FILTER (WHERE b.status = 'booked'), 0)::int as actual_booked_count
  FROM sessions s
  LEFT JOIN bookings b ON s.id = b.session_id
  WHERE s.opportunity_id = ANY($1)
  GROUP BY s.id, ...
  ORDER BY s.opportunity_id, s.start_time ASC
`, [opportunityIds]);
```

**Priority**: 🔴 **CRITICAL** - Affects main list endpoint

---

### 2. Loop-Based Queries in Conflict Checking

**Location**: `api/calendar/[...slug].ts` (lines 154-188)

**Issue**: Conflict checking queries database in a loop (one query per time slot).

**Impact**:
- For 50 time slots: **50 sequential queries**
- Slow response for bulk conflict checking
- Connection pool exhaustion

**Current Code**:
```typescript
for (const slot of time_slots) {
  const result = await query(`
    SELECT s.id, s.opportunity_id, ...
    FROM sessions s
    WHERE s.start_time < $1 AND s.end_time > $2
    LIMIT 1
  `, [slot.end_time, slot.start_time]);
}
```

**Recommended Fix**: Single query with batch check:
```typescript
// Single query to check all slots at once
const conflicts = await query(`
  SELECT 
    s.id, s.opportunity_id, s.start_time, s.end_time,
    ts.start_time as slot_start,
    ts.end_time as slot_end
  FROM unnest($1::timestamp[], $2::timestamp[]) AS ts(start_time, end_time)
  CROSS JOIN sessions s
  WHERE s.start_time < ts.end_time 
    AND s.end_time > ts.start_time
    ${opportunity_id ? 'AND s.opportunity_id != $3' : ''}
`, [
  time_slots.map(s => s.start_time),
  time_slots.map(s => s.end_time),
  ...(opportunity_id ? [opportunity_id] : [])
]);
```

**Priority**: 🔴 **HIGH** - Affects calendar creation performance

---

### 3. Multiple Duplicate API Calls on Component Mount

**Location**: `frontend/src/pages/Home.tsx` (lines 63-92)

**Issue**: Multiple `useEffect` hooks all call `loadOpportunities()` on mount, causing 3+ duplicate API calls.

**Impact**:
- Unnecessary network requests
- Server load multiplication
- Slower perceived performance

**Current Code**:
```typescript
useEffect(() => {
  loadOpportunities(); // Call 1
}, []);

useEffect(() => {
  setTimeout(() => {
    loadOpportunities(); // Call 2
  }, 50);
}, []);

useEffect(() => {
  if (location.pathname === '/') {
    setTimeout(() => {
      loadOpportunities(); // Call 3
    }, 100);
  }
}, [location.pathname]);
```

**Recommended Fix**: Consolidate to single useEffect with proper dependencies:
```typescript
useEffect(() => {
  const timer = setTimeout(() => {
    loadOpportunities();
  }, 50);
  return () => clearTimeout(timer);
}, [location.pathname]); // Only reload when pathname changes
```

**Priority**: 🔴 **HIGH** - Wastes resources and slows initial load

---

### 4. No Pagination on Opportunities List

**Location**: 
- `api/opportunities.ts`
- `backend/src/routes/opportunities.ts`

**Issue**: All opportunities are loaded at once without pagination or limits.

**Impact**:
- Slow response as data grows
- High memory usage
- Poor user experience with many items
- Network transfer overhead

**Recommended Fix**: Add pagination:
```typescript
const page = parseInt(req.query.page as string) || 1;
const limit = parseInt(req.query.limit as string) || 20;
const offset = (page - 1) * limit;

sql += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
params.push(limit, offset);
paramIndex += 2;

// Return pagination metadata
return res.status(200).json({
  opportunities,
  pagination: {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit)
  }
});
```

**Priority**: 🟡 **MEDIUM** - Becomes critical as data scales

---

### 5. Database Connection Pool Too Restrictive

**Location**: `api/db.ts` (line 35)

**Issue**: Connection pool has `max: 1`, which is too restrictive even for serverless.

**Impact**:
- Queueing of requests under concurrent load
- Timeout errors when multiple functions run simultaneously
- Poor scalability

**Current Code**:
```typescript
pool = new Pool({
  connectionString: cleanUrl,
  max: 1, // Too restrictive!
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});
```

**Recommended Fix**: Increase pool size for serverless:
```typescript
pool = new Pool({
  connectionString: cleanUrl,
  max: 10, // Allow more concurrent connections
  min: 0,  // Don't maintain idle connections in serverless
  idleTimeoutMillis: 10000, // Shorter for serverless
  connectionTimeoutMillis: 5000,
});
```

**Priority**: 🟡 **MEDIUM** - Affects concurrent request handling

---

### 6. Missing Database Indexes

**Location**: Database migrations

**Issue**: Several frequently queried columns may lack indexes:

1. **sessions.opportunity_id** - Used in every opportunities list query
2. **sessions.start_time, sessions.end_time** - Used for conflict checking
3. **bookings.session_id** - Used for booked_count calculations
4. **opportunities.status** - Filtered in every list query
5. **opportunities.type** - Filtered frequently
6. **opportunities.created_at** - Used for sorting

**Impact**: 
- Slow queries as data grows
- Full table scans on large tables
- Poor sorting performance

**Recommended Fix**: Add indexes in migrations:
```sql
-- Composite indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_sessions_opportunity_time 
ON sessions(opportunity_id, start_time ASC);

CREATE INDEX IF NOT EXISTS idx_sessions_time_range 
ON sessions USING GIST (tstzrange(start_time, end_time));

CREATE INDEX IF NOT EXISTS idx_bookings_session_status 
ON bookings(session_id, status) 
WHERE status = 'booked';

CREATE INDEX IF NOT EXISTS idx_opportunities_status_type_created 
ON opportunities(status, type, created_at DESC);

-- Full text search index (if search becomes common)
CREATE INDEX IF NOT EXISTS idx_opportunities_search 
ON opportunities USING gin(to_tsvector('english', title || ' ' || COALESCE(purpose_one_liner, '')));
```

**Priority**: 🟡 **MEDIUM** - Important for scale

---

### 7. Inefficient booked_count Calculation

**Location**: 
- `api/opportunities.ts` (lines 114-124)
- `api/opportunities/[id].ts` (lines 98-111)

**Issue**: `booked_count` is recalculated using `COUNT()` with GROUP BY for every session on every request.

**Impact**:
- Expensive aggregation queries
- Slow response when many sessions have bookings

**Recommended Fix**: Use materialized view or denormalize:
```typescript
// Option 1: Cache in sessions table (with trigger to update)
ALTER TABLE sessions ADD COLUMN cached_booked_count INTEGER DEFAULT 0;

// Trigger to update on booking changes
CREATE OR REPLACE FUNCTION update_session_booked_count()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE sessions 
  SET cached_booked_count = (
    SELECT COUNT(*) FROM bookings 
    WHERE session_id = NEW.session_id AND status = 'booked'
  )
  WHERE id = NEW.session_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

// Option 2: Use a single query with window function
SELECT s.*,
  COUNT(b.id) FILTER (WHERE b.status = 'booked') OVER (PARTITION BY s.id) as booked_count
FROM sessions s
LEFT JOIN bookings b ON s.id = b.session_id
WHERE s.opportunity_id = $1;
```

**Priority**: 🟡 **MEDIUM** - Optimization opportunity

---

### 8. No Query Result Caching

**Location**: Multiple API endpoints

**Issue**: No caching for frequently accessed, rarely-changing data:
- Dashboard stats
- Leaderboard data
- Opportunity list (for non-admins)

**Impact**:
- Repeated database queries for same data
- Unnecessary database load

**Recommended Fix**: Add caching layer:
```typescript
// For serverless, use Vercel's edge caching or Redis
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.REDIS_URL,
  token: process.env.REDIS_TOKEN,
});

export async function getCachedOpportunities(key: string, fetcher: () => Promise<any>) {
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached);
  
  const data = await fetcher();
  await redis.set(key, JSON.stringify(data), { ex: 60 }); // 60s cache
  return data;
}
```

**Priority**: 🟢 **LOW** - Nice to have optimization

---

## 🟡 Optimization Opportunities

### 9. Frontend: Missing React.memo and useMemo

**Location**: Multiple React components

**Issue**: Components re-render unnecessarily when props haven't changed.

**Examples**:
- `CalendarGrid.tsx` - Re-renders on every parent update
- `AdminSessionManager.tsx` - Large component with complex state
- Opportunity cards in list views

**Recommended Fix**: Add memoization:
```typescript
// Memoize expensive components
export const CalendarGrid = React.memo<CalendarGridProps>(({ sessions, ... }) => {
  // Component code
});

// Memoize expensive calculations
const sortedSessions = useMemo(() => {
  return sessions.sort((a, b) => a.start_time.localeCompare(b.start_time));
}, [sessions]);
```

**Priority**: 🟡 **MEDIUM** - Improves UI responsiveness

---

### 10. Frontend: Unnecessary Re-fetches

**Location**: `frontend/src/pages/OpportunityDetail.tsx` (line 57)

**Issue**: Always force-refreshes on mount, even if data is fresh.

**Recommended Fix**: Use conditional refresh:
```typescript
useEffect(() => {
  // Only force refresh if data is stale (older than 30s)
  const shouldRefresh = !opportunity || 
    (Date.now() - new Date(opportunity.updated_at).getTime()) > 30000;
  loadOpportunity(shouldRefresh);
}, [id]);
```

**Priority**: 🟢 **LOW** - Minor optimization

---

### 11. Large Bundle Size

**Location**: `frontend/package.json`

**Issue**: Bootstrap and React-Bootstrap add significant bundle size (~150KB gzipped).

**Recommendation**: Consider lighter alternatives:
- Tailwind CSS (smaller, tree-shakeable)
- Remove Bootstrap if not heavily used

**Priority**: 🟢 **LOW** - Consider for future optimization

---

### 12. Missing Response Compression

**Location**: API responses

**Issue**: Large JSON responses aren't compressed.

**Recommendation**: Enable gzip compression in Vercel (should be automatic) or add middleware.

**Priority**: 🟢 **LOW** - Usually handled by hosting platform

---

### 13. No Database Query Logging/Monitoring

**Issue**: No visibility into slow queries.

**Recommendation**: Add query performance monitoring:
```typescript
const queryWithLogging = async (text: string, params?: any[]) => {
  const start = Date.now();
  const result = await query(text, params);
  const duration = Date.now() - start;
  if (duration > 100) { // Log slow queries
    console.warn(`Slow query (${duration}ms):`, text.substring(0, 100));
  }
  return result;
};
```

**Priority**: 🟢 **LOW** - Helps identify issues

---

## Recommended Action Plan

### Phase 1: Critical Fixes (Immediate)
1. ✅ Fix N+1 queries in opportunities list endpoint
2. ✅ Fix loop-based conflict checking
3. ✅ Remove duplicate API calls in Home component
4. ✅ Add pagination to opportunities list

**Estimated Impact**: 50-80% reduction in database queries, 2-5x faster response times

### Phase 2: Database Optimization (High Priority)
1. ✅ Increase connection pool size
2. ✅ Add missing database indexes
3. ✅ Optimize booked_count calculation

**Estimated Impact**: 30-50% faster queries under load

### Phase 3: Frontend Optimization (Medium Priority)
1. ✅ Add React.memo where appropriate
2. ✅ Optimize re-renders
3. ✅ Add caching for static data

**Estimated Impact**: Smoother UI, 20-30% faster perceived performance

### Phase 4: Monitoring & Polish (Low Priority)
1. ✅ Add query performance monitoring
2. ✅ Consider bundle size optimization
3. ✅ Review and optimize other endpoints

---

## Performance Metrics to Track

After implementing fixes, monitor:

1. **API Response Times**
   - Opportunities list: Target < 200ms
   - Conflict checking: Target < 100ms
   - Individual opportunity: Target < 150ms

2. **Database Metrics**
   - Query count per request
   - Average query time
   - Connection pool utilization

3. **Frontend Metrics**
   - Time to first paint
   - Time to interactive
   - Bundle size

---

## Conclusion

The codebase has several performance issues, with the most critical being N+1 query problems that will severely impact performance as data scales. The recommended fixes are straightforward and will provide significant performance improvements.

**Estimated Overall Performance Gain**: 3-5x improvement in response times after Phase 1-2 fixes.

---

## Implementation Priority Matrix

| Issue | Impact | Effort | Priority |
|-------|--------|--------|----------|
| N+1 Queries (Opportunities) | 🔴 High | 🟡 Medium | **P0** |
| Loop Queries (Conflicts) | 🔴 High | 🟡 Medium | **P0** |
| Duplicate API Calls | 🟡 Medium | 🟢 Low | **P1** |
| Missing Pagination | 🟡 Medium | 🟡 Medium | **P1** |
| Connection Pool | 🟡 Medium | 🟢 Low | **P1** |
| Missing Indexes | 🟡 Medium | 🟡 Medium | **P2** |
| booked_count Optimization | 🟡 Medium | 🔴 High | **P2** |
| React Memoization | 🟢 Low | 🟡 Medium | **P3** |

---

**Report Generated**: 2025-01-27

