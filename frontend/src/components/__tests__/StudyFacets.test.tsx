import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';

import StudyFacets from '../StudyFacets';
import {
  EMPTY_FACET_SELECTION,
  type FacetOptions,
  type StudyFacetSelection,
} from '../../utils/opportunityUtils';

const options: FacetOptions = {
  roles: ['Product Manager', 'Designer'],
  types: ['test', 'survey'],
  deliveries: ['in_app', 'external'],
  timeBuckets: ['under_5', '30_plus'],
};

const setup = (selection: StudyFacetSelection = EMPTY_FACET_SELECTION) => {
  const onChange = vi.fn();
  render(<StudyFacets options={options} selection={selection} onChange={onChange} />);
  return { onChange };
};

describe('StudyFacets', () => {
  it('renders a group per axis with only the present options', () => {
    setup();
    const typeGroup = screen.getByRole('group', { name: 'Type' });
    // Participant-facing labels for the two present types.
    expect(within(typeGroup).getAllByRole('button')).toHaveLength(2);
    expect(screen.getByRole('group', { name: 'Roles or skills' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Where' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Time' })).toBeInTheDocument();
  });

  it('toggles a value into the axis on click (OR within an axis)', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();
    await user.click(screen.getByRole('button', { name: 'Designer' }));
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_FACET_SELECTION, roles: ['Designer'] });
  });

  it('toggles a selected value back off', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ ...EMPTY_FACET_SELECTION, roles: ['Designer'] });
    await user.click(screen.getByRole('button', { name: 'Designer' }));
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_FACET_SELECTION, roles: [] });
  });

  it('marks a selected chip with aria-pressed', () => {
    setup({ ...EMPTY_FACET_SELECTION, roles: ['Designer'] });
    expect(screen.getByRole('button', { name: 'Designer' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Product Manager' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows a "Clear all" only when something is selected, and clears via onChange', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ ...EMPTY_FACET_SELECTION, types: ['test'] });
    const clear = screen.getByRole('button', { name: /clear all/i });
    await user.click(clear);
    expect(onChange).toHaveBeenCalledWith(EMPTY_FACET_SELECTION);
  });

  it('hides "Clear all" when nothing is selected', () => {
    setup();
    expect(screen.queryByRole('button', { name: /clear all/i })).toBeNull();
  });

  it('renders nothing when there are no options at all', () => {
    const { container } = render(
      <StudyFacets
        options={{ roles: [], types: [], deliveries: [], timeBuckets: [] }}
        selection={EMPTY_FACET_SELECTION}
        onChange={vi.fn()}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  describe('keyword search', () => {
    const NO_OPTIONS: FacetOptions = { roles: [], types: [], deliveries: [], timeBuckets: [] };

    it('renders the search box only when onQueryChange is provided', () => {
      const { rerender } = render(
        <StudyFacets options={options} selection={EMPTY_FACET_SELECTION} onChange={vi.fn()} />
      );
      expect(screen.queryByRole('textbox', { name: /search studies/i })).toBeNull();

      rerender(
        <StudyFacets
          options={options}
          selection={EMPTY_FACET_SELECTION}
          onChange={vi.fn()}
          query=""
          onQueryChange={vi.fn()}
        />
      );
      expect(screen.getByRole('textbox', { name: /search studies/i })).toBeInTheDocument();
    });

    it('calls onQueryChange as the user types', async () => {
      const user = userEvent.setup();
      const onQueryChange = vi.fn();
      render(
        <StudyFacets
          options={options}
          selection={EMPTY_FACET_SELECTION}
          onChange={vi.fn()}
          query=""
          onQueryChange={onQueryChange}
        />
      );
      await user.type(screen.getByRole('textbox', { name: /search studies/i }), 'x');
      expect(onQueryChange).toHaveBeenCalledWith('x');
    });

    it('shows a clear-search button only when there is text, and clears via onQueryChange', async () => {
      const user = userEvent.setup();
      const onQueryChange = vi.fn();
      const { rerender } = render(
        <StudyFacets
          options={options}
          selection={EMPTY_FACET_SELECTION}
          onChange={vi.fn()}
          query=""
          onQueryChange={onQueryChange}
        />
      );
      expect(screen.queryByRole('button', { name: /clear search/i })).toBeNull();

      rerender(
        <StudyFacets
          options={options}
          selection={EMPTY_FACET_SELECTION}
          onChange={vi.fn()}
          query="onboarding"
          onQueryChange={onQueryChange}
        />
      );
      await user.click(screen.getByRole('button', { name: /clear search/i }));
      expect(onQueryChange).toHaveBeenCalledWith('');
    });

    it('shows the card with search even when there are no facet options', () => {
      render(
        <StudyFacets
          options={NO_OPTIONS}
          selection={EMPTY_FACET_SELECTION}
          onChange={vi.fn()}
          query=""
          onQueryChange={vi.fn()}
        />
      );
      expect(screen.getByRole('textbox', { name: /search studies/i })).toBeInTheDocument();
      // No facet chips, so no "Filter" header.
      expect(screen.queryByText('Filter')).toBeNull();
    });

    it('"Clear all" clears BOTH the facets and the search', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      const onQueryChange = vi.fn();
      render(
        <StudyFacets
          options={options}
          selection={{ ...EMPTY_FACET_SELECTION, types: ['test'] }}
          onChange={onChange}
          query="onboarding"
          onQueryChange={onQueryChange}
        />
      );
      await user.click(screen.getByRole('button', { name: /clear all/i }));
      expect(onChange).toHaveBeenCalledWith(EMPTY_FACET_SELECTION);
      expect(onQueryChange).toHaveBeenCalledWith('');
    });

    it('shows "Clear all" when only the search has text (no facet selected)', () => {
      render(
        <StudyFacets
          options={options}
          selection={EMPTY_FACET_SELECTION}
          onChange={vi.fn()}
          query="onboarding"
          onQueryChange={vi.fn()}
        />
      );
      expect(screen.getByRole('button', { name: /clear all/i })).toBeInTheDocument();
    });
  });
});
