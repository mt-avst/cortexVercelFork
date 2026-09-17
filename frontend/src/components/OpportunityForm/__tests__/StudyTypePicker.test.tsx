import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import StudyTypePicker from '../StudyTypePicker';

/*
 * D2 - the study-type picker. Nine cards replace the old "Research Study Type"
 * select and the "Where participants answer" delivery radios. Each card commits
 * an EXISTING (type, delivery_mode) pair - no enum is invented or renamed - so
 * getTabsForType keeps deciding the step set. Row 7: a published study's type is
 * read-only behind an explicit "Change study type" control.
 */

const NATIVE_COPY =
  'You write the questions here and the answers come back in Cortex. Nothing is recorded - no screen, no microphone, no camera.';
const EXTERNAL_COPY =
  'You give Cortex the link. SurveyMonkey, Google Forms, Typeform and the rest - Cortex sends people there and counts the clicks, and the answers live in that tool.';

const renderPicker = (props: Partial<React.ComponentProps<typeof StudyTypePicker>> = {}) => {
  const onSelect = vi.fn();
  render(
    <StudyTypePicker
      type=""
      deliveryMode="external"
      onSelect={onSelect}
      isPublished={false}
      {...props}
    />
  );
  return { onSelect };
};

describe('StudyTypePicker - the nine cards and their enum mapping', () => {
  // The card -> (type, delivery) contract, pinned as literals so a silent
  // remap fails by name.
  const CARDS: Array<[string, string, 'native' | 'external']> = [
    ['Interview', 'interview', 'external'],
    ['Live session', 'test', 'external'],
    ['Recorded session', 'unmoderated', 'external'],
    ['Quick poll, in Cortex', 'poll', 'native'],
    ['Quick poll, in an external tool', 'poll', 'external'],
    ['One question, in Cortex', 'question', 'native'],
    ['One question, in an external tool', 'question', 'external'],
    ['Survey, in Cortex', 'survey', 'native'],
    ['Survey, in an external tool', 'survey', 'external']
  ];

  it('renders exactly nine choosable cards', () => {
    renderPicker();
    expect(screen.getAllByRole('radio')).toHaveLength(9);
  });

  it.each(CARDS)(
    'the "%s" card selects type=%s delivery=%s',
    (name, type, delivery) => {
      const { onSelect } = renderPicker();
      fireEvent.click(screen.getByRole('radio', { name }));
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenCalledWith(type, delivery);
    }
  );

  it('groups the cards into interactive sessions and answer-based', () => {
    renderPicker();
    expect(
      screen.getByRole('heading', { name: /Interactive sessions/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /Answer-based/i })
    ).toBeInTheDocument();
  });

  it('carries the verbatim delivery copy on the answer-based cards', () => {
    renderPicker();
    // Native copy appears on the three "in Cortex" cards; external on the three
    // "in an external tool" cards.
    expect(screen.getAllByText(NATIVE_COPY)).toHaveLength(3);
    expect(screen.getAllByText(EXTERNAL_COPY)).toHaveLength(3);
  });

  it('marks the chosen card, and only it, as checked', () => {
    renderPicker({ type: 'survey', deliveryMode: 'native' });
    expect(
      screen.getByRole('radio', { name: 'Survey, in Cortex' })
    ).toHaveAttribute('aria-checked', 'true');
    expect(
      screen.getByRole('radio', { name: 'Survey, in an external tool' })
    ).toHaveAttribute('aria-checked', 'false');
    expect(
      screen.getByRole('radio', { name: 'Live session' })
    ).toHaveAttribute('aria-checked', 'false');
  });

  it('checks an interactive card on type alone, ignoring delivery mode', () => {
    // interview/test/unmoderated have one card each - delivery is not a choice
    // they carry, so a stale delivery_mode must not leave them unchecked.
    renderPicker({ type: 'test', deliveryMode: 'native' });
    expect(
      screen.getByRole('radio', { name: 'Live session' })
    ).toHaveAttribute('aria-checked', 'true');
  });
});

describe('StudyTypePicker - the type validation error', () => {
  it('shows the type error against the group', () => {
    renderPicker({ validationError: 'Choose a research study type' });
    expect(screen.getByText('Choose a research study type')).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: /study type/i })).toHaveAttribute(
      'aria-invalid',
      'true'
    );
  });
});

describe('StudyTypePicker - the D13 front-door AI shell (dormant)', () => {
  it('offers the prompt but leaves the Suggest control inert', () => {
    renderPicker();
    const prompt = screen.getByTestId('front-door-ai-prompt');
    expect(
      within(prompt).getByLabelText(/What do you want to find out/i)
    ).toBeInTheDocument();
    // Not wired yet (W9 lands the real thing): the control is present but inert.
    expect(
      within(prompt).getByRole('button', { name: /Suggest a type/i })
    ).toBeDisabled();
  });
});

describe('StudyTypePicker - row 7: a published study locks its type', () => {
  it('shows the type read-only behind a Change study type control, not the cards', () => {
    renderPicker({ type: 'survey', deliveryMode: 'native', isPublished: true });

    // Locked: no cards, and a control that names what changing detaches.
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.getByText(/Survey - In Cortex/i)).toBeInTheDocument();
    const change = screen.getByRole('button', { name: /Change study type/i });
    expect(change).toBeInTheDocument();
    expect(screen.getByText(/detaches/i)).toBeInTheDocument();
  });

  it('reveals the cards, with a warning, once the author chooses to change', () => {
    renderPicker({ type: 'survey', deliveryMode: 'native', isPublished: true });
    fireEvent.click(screen.getByRole('button', { name: /Change study type/i }));

    expect(screen.getAllByRole('radio')).toHaveLength(9);
    expect(screen.getByRole('alert')).toHaveTextContent(/detaches/i);
  });

  it('picks freely when the study is not published', () => {
    renderPicker({ type: '', isPublished: false });
    expect(screen.getAllByRole('radio')).toHaveLength(9);
    expect(
      screen.queryByRole('button', { name: /Change study type/i })
    ).toBeNull();
  });
});
