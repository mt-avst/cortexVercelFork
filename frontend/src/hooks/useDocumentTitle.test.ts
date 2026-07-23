import { renderHook } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';

import useDocumentTitle from './useDocumentTitle';

describe('useDocumentTitle', () => {
  beforeEach(() => {
    // The app's static baseline title (index.html).
    document.title = 'AdaptaLabs';
  });

  it('sets the document title while mounted', () => {
    renderHook(() => useDocumentTitle('Recorded study session'));
    expect(document.title).toBe('Recorded study session');
  });

  it('restores the previous title on unmount', () => {
    const { unmount } = renderHook(() => useDocumentTitle('Recorded study session'));
    expect(document.title).toBe('Recorded study session');

    unmount();
    expect(document.title).toBe('AdaptaLabs');
  });

  it('is a no-op when the title is undefined', () => {
    renderHook(() => useDocumentTitle(undefined));
    expect(document.title).toBe('AdaptaLabs');
  });

  it('updates the title when the argument changes and restores the original on unmount', () => {
    const { rerender, unmount } = renderHook(({ t }) => useDocumentTitle(t), {
      initialProps: { t: undefined as string | undefined },
    });
    // Undefined first: the static title holds (mirrors a page whose data is loading).
    expect(document.title).toBe('AdaptaLabs');

    rerender({ t: 'Loaded opportunity' });
    expect(document.title).toBe('Loaded opportunity');

    unmount();
    expect(document.title).toBe('AdaptaLabs');
  });
});
