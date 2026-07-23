import { useEffect } from 'react';

/**
 * Sets `document.title` to `title` while the calling component is mounted and
 * restores the previous title on unmount (or when `title` changes).
 *
 * A no-op when `title` is undefined, so a page can call it unconditionally with
 * a value that is still loading - the static title in index.html holds until the
 * real value lands. Restoring on unmount prevents a per-instance title (e.g. an
 * opportunity name) leaking into a title-less page after SPA navigation.
 *
 * Note: a defined -> undefined transition leaves the last set title in place
 * rather than restoring (the undefined branch registers no cleanup). Neither
 * current caller does this; a caller that toggles a title back to undefined
 * should not rely on an automatic restore.
 */
export default function useDocumentTitle(title?: string): void {
  useEffect(() => {
    if (title === undefined) {
      return;
    }
    const previousTitle = document.title;
    document.title = title;
    return () => {
      document.title = previousTitle;
    };
  }, [title]);
}
