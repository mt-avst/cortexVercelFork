import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import StudyFilters from '../StudyFilters';

// The chips and the rows below them describe the same list. When the rows moved
// to participant vocabulary the chips did not, so the page said "Unmoderated"
// above rows saying "Recorded study" - the same list naming itself two ways.
describe('StudyFilters', () => {
  const renderFilters = (currentFilter = 'all') => {
    const onFilterChange = vi.fn();
    render(<StudyFilters currentFilter={currentFilter} onFilterChange={onFilterChange} />);
    return onFilterChange;
  };

  it('labels every chip in participant vocabulary', () => {
    renderFilters();

    expect(screen.getByRole('button', { name: 'Recorded study' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Usability test' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Quick poll' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'One question' })).toBeVisible();
  });

  it('never shows the internal type names', () => {
    renderFilters();

    for (const internal of ['unmoderated', 'app testing', 'question']) {
      expect(
        screen.queryByRole('button', { name: new RegExp(`^${internal}$`, 'i') })
      ).toBeNull();
    }
  });

  it('keeps an "All" chip, which is not a type', () => {
    renderFilters();
    expect(screen.getByRole('button', { name: 'All' })).toBeVisible();
  });

  // The label is what changed; the value passed back must not have.
  it('still reports the internal type value when a chip is chosen', () => {
    const onFilterChange = renderFilters();

    fireEvent.click(screen.getByRole('button', { name: 'Recorded study' }));
    expect(onFilterChange).toHaveBeenCalledWith('unmoderated');

    fireEvent.click(screen.getByRole('button', { name: 'Usability test' }));
    expect(onFilterChange).toHaveBeenCalledWith('test');
  });

  it('marks the active chip as pressed, and only that one', () => {
    renderFilters('unmoderated');

    expect(screen.getByRole('button', { name: 'Recorded study' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });
});
