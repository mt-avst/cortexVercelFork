import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { orderStudyKebabActions, StudyKebabOrderInput } from '../kebabOrder';

/**
 * orderStudyKebabActions (extracted from Admin.tsx): Edit, Preview as
 * participant, Analytics (Petra 3.4's default order) unless the compact list
 * (< COMPACT_ACTIONS_BREAKPOINT) needs one of them promoted to lead the menu -
 * matched by the row's own primary action's `.to`, not by label, so either
 * "Fix" or "Edit" still leads with the Edit item (both target `editPath`).
 * TESTLANE-C section 2.
 */

const baseInput: StudyKebabOrderInput = {
  isCompactActions: true,
  canManage: true,
  notWorking: false,
  editPath: '/admin/opportunities/x/edit',
  previewPath: '/opportunities/x',
  analyticsPath: '/admin/opportunities/x/analytics',
  ownerName: 'Alex Owner',
  primaryActionTo: '/admin/opportunities/x/edit',
};

const renderOrder = (input: StudyKebabOrderInput): string[] => {
  const { container } = render(
    <MemoryRouter>
      <ul>{orderStudyKebabActions(input)}</ul>
    </MemoryRouter>
  );
  return Array.from(container.querySelectorAll('.dropdown-item')).map((el) => el.textContent);
};

describe('orderStudyKebabActions (kebabOrder)', () => {
  it('is Edit, Preview as participant, Analytics outside the compact list, whatever the primary action is', () => {
    expect(
      renderOrder({ ...baseInput, isCompactActions: false, primaryActionTo: baseInput.analyticsPath })
    ).toEqual(['Edit', 'Preview as participant', 'Analytics']);
  });

  it('compact + Edit leads (the primary action is Edit)', () => {
    expect(renderOrder({ ...baseInput, primaryActionTo: baseInput.editPath })).toEqual([
      'Edit',
      'Preview as participant',
      'Analytics',
    ]);
  });

  it('compact + Preview leads, including a study the viewer does not own (Preview first)', () => {
    // A non-owner viewer: canManage false demotes Edit and Analytics to
    // disabled items, and the row's own primary action is Preview.
    expect(
      renderOrder({ ...baseInput, canManage: false, primaryActionTo: baseInput.previewPath })
    ).toEqual(['Preview as participant', 'Edit', 'Analytics']);
  });

  it('compact + Analytics leads', () => {
    expect(renderOrder({ ...baseInput, primaryActionTo: baseInput.analyticsPath })).toEqual([
      'Analytics',
      'Edit',
      'Preview as participant',
    ]);
  });

  it('compact + Fix leads (a broken, owned study) - reads "Fix", matched by its shared editPath target, not by label', () => {
    expect(
      renderOrder({ ...baseInput, notWorking: true, primaryActionTo: baseInput.editPath })
    ).toEqual(['Fix', 'Preview as participant', 'Analytics']);
  });

  it('disables Edit for a non-owner, with the owner named in its reason', () => {
    const { getByRole } = render(
      <MemoryRouter>
        <ul>{orderStudyKebabActions({ ...baseInput, canManage: false, primaryActionTo: baseInput.previewPath })}</ul>
      </MemoryRouter>
    );
    const edit = getByRole('menuitem', { name: 'Edit' });
    expect(edit).toBeDisabled();
    expect(edit).toHaveAttribute('title', 'Only the owner can edit this study');
  });

  it('disables Analytics for a non-owner, naming the owner in its reason', () => {
    const { getByRole } = render(
      <MemoryRouter>
        <ul>{orderStudyKebabActions({ ...baseInput, canManage: false, primaryActionTo: baseInput.previewPath })}</ul>
      </MemoryRouter>
    );
    const analytics = getByRole('menuitem', { name: 'Analytics' });
    expect(analytics).toBeDisabled();
    expect(analytics).toHaveAttribute('title', 'Only Alex Owner can view analytics for this study');
  });
});
