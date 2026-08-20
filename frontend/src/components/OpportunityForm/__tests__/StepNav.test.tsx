import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import StepNav from '../StepNav';
import type { StepStatus } from '../../../lib/opportunity-authoring/step-status';
import type { FormStep } from '../../../pages/OpportunityForm';

const STEPS: FormStep[] = [
  { id: 1, key: 'basics', title: 'Basic Information', description: 'Configure type and status' },
  { id: 2, key: 'content', title: 'Content & Details', description: 'Define opportunity content' },
  { id: 3, key: 'taskList', title: 'Task List', description: 'What the participant does' },
  { id: 4, key: 'consent', title: 'Consent', description: 'What the participant agrees to' }
];

const ALL: StepStatus[] = ['needsAttention', 'current', 'completed', 'notStarted'];

const renderNav = (statuses: StepStatus[] = ALL, activeStepId = 2, onSelect = vi.fn()) => {
  const result = render(
    <StepNav
      steps={STEPS}
      activeStepId={activeStepId}
      statusOf={(step) => statuses[step.id - 1]}
      onSelect={onSelect}
    />
  );
  return { ...result, onSelect };
};

const stepButtons = () =>
  within(screen.getByRole('navigation', { name: 'Form steps' })).getAllByRole('button');

describe('StepNav', () => {
  it('stays addressable as a button, and does not take the tab role', () => {
    renderNav();

    // Around a hundred test call sites and five Playwright specs address these
    // by their button role or by `.nav-link`. `role="tab"` REPLACES the button
    // role, so this is a contract with the rest of the repo, not a preference.
    expect(stepButtons()).toHaveLength(4);
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    stepButtons().forEach((button) => {
      expect(button).toHaveClass('nav-link');
    });
  });

  it('gives each state its own icon, so colour is never the only carrier', () => {
    renderNav();

    const icons = stepButtons().map((button) =>
      button.querySelector('.step-tab__status svg')?.getAttribute('class')
    );

    expect(icons).toEqual([
      expect.stringContaining('lucide-circle-alert'),
      expect.stringContaining('lucide-circle-dot'),
      expect.stringContaining('lucide-circle-check-big'),
      expect.stringContaining('lucide-circle')
    ]);
    // And they are four DIFFERENT icons - the assertion above would pass with
    // four copies of one of them, because `lucide-circle` is a prefix of two
    // of the others.
    expect(new Set(icons).size).toBe(4);
  });

  it('hides the icon from assistive technology and states the status in words', () => {
    renderNav();

    stepButtons().forEach((button) => {
      expect(button.querySelector('.step-tab__status svg')).toHaveAttribute('aria-hidden', 'true');
    });
    expect(stepButtons()[0]).toHaveTextContent('Needs attention');
    expect(stepButtons()[3]).toHaveTextContent('Not started');
  });

  it('carries a per-state class, which is what the theme colours hang off', () => {
    renderNav();

    expect(stepButtons().map((button) => button.querySelector('.step-tab__status')?.className)).toEqual([
      expect.stringContaining('step-tab__status--needsAttention'),
      expect.stringContaining('step-tab__status--current'),
      expect.stringContaining('step-tab__status--completed'),
      expect.stringContaining('step-tab__status--notStarted')
    ]);
  });

  it('gives a failing step the same token the question cards use', () => {
    renderNav();

    // B2 gave `validation-error` its one definition per theme. A second colour
    // for the same idea is a colour that drifts.
    expect(stepButtons()[0].querySelector('.step-tab__status')).toHaveClass('validation-error');
    expect(stepButtons()[2].querySelector('.step-tab__status')).not.toHaveClass('validation-error');
  });

  it('reports each step at its own position, not at its id', () => {
    render(
      <StepNav steps={SPARSE} activeStepId={4} statusOf={() => 'current'} onSelect={vi.fn()} />
    );

    expect(stepButtons().map((button) => button.textContent)).toEqual([
      expect.stringContaining('Step 1 of 3'),
      expect.stringContaining('Step 2 of 3'),
      expect.stringContaining('Step 3 of 3')
    ]);
  });

  /**
   * Steps 1, 2 and 4 - the shape the form takes while no type is chosen and
   * the Consent step is the last one rendered.
   *
   * Every test below that cares about id-versus-position uses THIS list and
   * not the four-step one, deliberately. In the four-step list `id` and
   * `index + 1` are equal for every row, so a component that had confused the
   * two would behave identically and a matrix probing for it would report a
   * clean kill it had not earned.
   */
  const SPARSE = [STEPS[0], STEPS[1], STEPS[3]];

  it('asks about each step by identity, not by where it sits', () => {
    const statusOf = vi.fn<(step: FormStep) => StepStatus>(() => 'notStarted');
    render(
      <StepNav steps={SPARSE} activeStepId={1} statusOf={statusOf} onSelect={vi.fn()} />
    );

    // Ids AND keys, because the page needs both: errors are located by id and
    // history is held by key, and id 3 is four different steps.
    expect(statusOf.mock.calls.map(([step]) => [step.id, step.key])).toEqual([
      [1, 'basics'],
      [2, 'content'],
      [4, 'consent']
    ]);
  });

  it('reports the step it was asked about, not the one next to it', () => {
    render(
      <StepNav
        steps={SPARSE}
        activeStepId={1}
        statusOf={(step) => (step.id === 4 ? 'needsAttention' : 'completed')}
        onSelect={vi.fn()}
      />
    );

    expect(stepButtons()[2]).toHaveTextContent('Needs attention');
    expect(stepButtons()[1]).not.toHaveTextContent('Needs attention');
  });

  it('selects the step that was clicked, by id', () => {
    const onSelect = vi.fn();
    render(<StepNav steps={SPARSE} activeStepId={1} statusOf={() => 'current'} onSelect={onSelect} />);

    fireEvent.click(stepButtons()[2]);

    // 4, not 3: the third step rendered is step 4 on this shape.
    expect(onSelect).toHaveBeenCalledWith(4);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
