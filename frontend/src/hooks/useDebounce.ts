import { useEffect, useState } from 'react';

/**
 * Returns a debounced copy of `value` that only updates after `delay` ms have
 * passed without a further change. Used by the Browse keyword search so the list
 * re-filters after the user pauses typing, not on every keystroke.
 *
 * The timer is cleared on each change (and on unmount), so a rapid sequence of
 * edits collapses to a single trailing update.
 */
export function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState<T>(value);

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(handle);
  }, [value, delay]);

  return debounced;
}

export default useDebounce;
