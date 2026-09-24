import { useEffect, useState } from 'react';

/**
 * Shared responsive breakpoints for the Admin dashboard.
 *
 * Both of these used to be literals duplicated between Admin.tsx (which
 * needs the real value in JS - which control leads the kebab, which filter
 * toolbar renders - decisions CSS alone cannot make) and a `@media` rule in
 * `_components.css`, and drifted apart once already. One number, one file:
 * every `@media` rule that must stay in step with one of these names it in
 * a comment ("keep in step with COMPACT_ACTIONS_BREAKPOINT /
 * PHONE_BREAKPOINT, utils/adminBreakpoints.ts"), and this file names the
 * CSS rule back.
 */

/** Below this width the Research Studies row loses its visible state button
 * (compact list items leave no room for a second control beside the kebab),
 * so the kebab itself has to lead with that action instead
 * (`_components.css`, "ROW 14 - Research Studies table reflows to cards"). */
export const COMPACT_ACTIONS_BREAKPOINT = 1023.98;
export const COMPACT_ACTIONS_QUERY = `(max-width: ${COMPACT_ACTIONS_BREAKPOINT}px)`;

/** Below this width the phone spec applies: the "Filters"
 * disclosure toolbar (`components/admin/PhoneStudyFilters.tsx`) replaces the
 * always-visible Status/Type/Sort-by fields, and the tabs card's own border
 * and padding are dropped so every block on the page - header, Needs
 * attention, snapshot, tabs, filters, list items - shares one 16px gutter
 * (`_components.css`, "PHONE GUTTER"). */
export const PHONE_BREAKPOINT = 575.98;
export const PHONE_QUERY = `(max-width: ${PHONE_BREAKPOINT}px)`;

/** jsdom (the unit-test DOM) has no `window.matchMedia` at all, not even a
 * stub that always answers `false` - calling it throws `TypeError:
 * window.matchMedia is not a function` and takes the whole component down
 * with it, in every test that renders Admin. Guarded on the function
 * existing, not just on `window` existing. */
export const supportsMatchMedia = (): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function';

/**
 * A live `matchMedia` boolean for `query`: starts from the real value
 * (never a guessed initial state, which would flash the wrong layout on a
 * narrow first paint) and updates on change - `matchMedia`'s own `change`
 * event fires on an orientation change too, where a plain resize listener
 * would not.
 */
export const useMatchMedia = (query: string): boolean => {
  const [matches, setMatches] = useState(
    () => supportsMatchMedia() && window.matchMedia(query).matches
  );
  useEffect(() => {
    if (!supportsMatchMedia()) return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
};
