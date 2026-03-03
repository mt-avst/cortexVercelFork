# Performance changes – browser & smoke test results

**Date**: 2026-02-02  
**Changes**: v7.2.3 – neural background node/dpr/Bloom reductions, prefers-reduced-motion skip, SpotlightCard raf throttle

---

## Playwright MCP (production)

| Check | Result |
|-------|--------|
| **Landing (dark)** | Page loads; `theme-dark`, 1 WebGL canvas (OrganicNeuralBackground). |
| **prefers-reduced-motion** | `false` in test env – Canvas rendered as expected. When OS “Reduce motion” is on, Canvas is skipped (static gradient only). |
| **Feedback** | Page loads; form and category visible. No canvas (Feedback does not use SlowNeuralBackground). |
| **Console** | Only WebGL driver ReadPixels warnings (benign). No app errors. |

---

## Smoke tests (local vs production URL)

- **7 passed**, **2 skipped** (opportunity detail, demo login – no data/links).
- Home load, opportunities list/degraded, feedback, no console errors, domcontentloaded &lt; 5s, API health, demo access hidden.

---

## Conclusion

- Neural backgrounds render with reduced node count and dpr; no regressions observed.
- Smoke suite passes; performance changes are safe to ship.
- **prefers-reduced-motion**: Not asserted in browser (would require OS “Reduce motion”); code path skips Canvas when `matchMedia('prefers-reduced-motion: reduce')` is true.
- **SpotlightCard**: Throttling is in code; full flow (study listing + hover) would need an authenticated session to verify in browser.
