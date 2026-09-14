import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { SortCaret } from '../SortCaret';

/**
 * Four admin/analytics tables each hand-rolled the same
 * `{active ? (asc ? ' ↑' : ' ↓') : ''}` ternary with a literal unicode arrow.
 * One component now backs every column header's sort indicator.
 */
describe('SortCaret', () => {
  it('renders nothing visible when the column is not the active sort', () => {
    const { container } = render(<SortCaret active={false} direction="asc" />);
    expect(container.querySelector('svg')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('renders an up glyph, not a unicode arrow, for an ascending active sort', () => {
    const { container, queryByText } = render(<SortCaret active direction="asc" />);
    expect(container.querySelector('svg')).not.toBeNull();
    expect(queryByText(/↑/)).toBeNull();
  });

  it('renders a down glyph for a descending active sort', () => {
    const { container, queryByText } = render(<SortCaret active direction="desc" />);
    expect(container.querySelector('svg')).not.toBeNull();
    expect(queryByText(/↓/)).toBeNull();
  });

  it('is decorative: aria-hidden, the header cell carries aria-sort', () => {
    const { container } = render(<SortCaret active direction="asc" />);
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps the admin-th-sort-caret class so no stylesheet rule needs to move', () => {
    const { container } = render(<SortCaret active={false} direction="asc" />);
    expect(container.querySelector('.admin-th-sort-caret')).not.toBeNull();
  });
});
