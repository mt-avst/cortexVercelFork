import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import StudyTypePicker from '../StudyTypePicker';
import { getAiDraftingAvailable } from '../../../api/client';

vi.mock('../../../api/client', async () => {
  const actual = await vi.importActual<typeof import('../../../api/client')>(
    '../../../api/client'
  );
  return {
    ...actual,
    getAiDraftingAvailable: vi.fn(),
    draftOpportunityFromBrief: vi.fn()
  };
});

/*
 * D2/reshape - the study-type picker. Six pods (one per `type`), grouped under
 * two scheduling eyebrows ("Live studies" / "Async studies"), replace the old
 * nine-card grid; a separate delivery toggle ("In Cortex" / "In an external
 * tool") appears only once an answer-based type is picked. Each pod or toggle
 * click commits an EXISTING (type, delivery_mode) pair - no enum is invented or
 * renamed - so getTabsForType keeps deciding the step set. Row 7: a published
 * study's type is read-only behind an explicit "Change study type" control.
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

describe('StudyTypePicker - the six pods and their enum mapping', () => {
  // The pod -> `type` contract, pinned as literals so a silent remap fails by
  // name. Every pod carries the SAME external default on first pick (D2's
  // `deliveryForPod`), which is what makes clicking a pod alone always land on
  // the system default rather than whatever the last answer-based pick left
  // behind.
  const PODS: Array<[string, string]> = [
    ['Interview', 'interview'],
    ['Live session', 'test'],
    ['Recorded session', 'unmoderated'],
    ['Poll', 'poll'],
    ['One question', 'question'],
    ['Survey', 'survey']
  ];

  it('renders exactly six choosable pods', () => {
    renderPicker();
    expect(screen.getAllByRole('radio')).toHaveLength(6);
  });

  it.each(PODS)('the "%s" pod selects type=%s, carrying the external default', (name, type) => {
    const { onSelect } = renderPicker();
    fireEvent.click(screen.getByRole('radio', { name }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(type, 'external');
  });

  it('groups the pods into Live studies and Async studies', () => {
    renderPicker();
    expect(
      screen.getByRole('heading', { name: /Live studies/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /Async studies/i })
    ).toBeInTheDocument();
  });

  it('marks the chosen pod, and only it, as checked', () => {
    renderPicker({ type: 'survey', deliveryMode: 'native' });
    expect(
      screen.getByRole('radio', { name: 'Survey' })
    ).toHaveAttribute('aria-checked', 'true');
    expect(
      screen.getByRole('radio', { name: 'Live session' })
    ).toHaveAttribute('aria-checked', 'false');
  });

  it('checks an interactive pod on type alone, ignoring delivery mode', () => {
    // interview/test/unmoderated have one pod each - delivery is not a choice
    // they carry, so a stale delivery_mode must not leave them unchecked.
    renderPicker({ type: 'test', deliveryMode: 'native' });
    expect(
      screen.getByRole('radio', { name: 'Live session' })
    ).toHaveAttribute('aria-checked', 'true');
  });
});

describe('StudyTypePicker - the delivery toggle', () => {
  it('does not render before any type is chosen', () => {
    renderPicker({ type: '' });
    expect(
      screen.queryByRole('radiogroup', { name: 'Where participants answer' })
    ).toBeNull();
  });

  it('does not render for an interactive type, which carries no delivery choice', () => {
    renderPicker({ type: 'test' });
    expect(
      screen.queryByRole('radiogroup', { name: 'Where participants answer' })
    ).toBeNull();
  });

  it('carries the verbatim delivery copy once an answer-based type is picked', () => {
    renderPicker({ type: 'survey' });
    expect(screen.getByText(NATIVE_COPY)).toBeInTheDocument();
    expect(screen.getByText(EXTERNAL_COPY)).toBeInTheDocument();
  });

  it('selects native delivery without changing the type', () => {
    const { onSelect } = renderPicker({ type: 'poll', deliveryMode: 'external' });
    fireEvent.click(screen.getByRole('radio', { name: 'In Cortex' }));
    expect(onSelect).toHaveBeenCalledWith('poll', 'native');
  });

  it('marks the chosen delivery, and only it, as checked', () => {
    renderPicker({ type: 'poll', deliveryMode: 'native' });
    expect(
      screen.getByRole('radio', { name: 'In Cortex' })
    ).toHaveAttribute('aria-checked', 'true');
    expect(
      screen.getByRole('radio', { name: 'In an external tool' })
    ).toHaveAttribute('aria-checked', 'false');
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

describe('StudyTypePicker - the D13 front-door AI panel (wired by W9)', () => {
  // DescribeIt itself (the live textarea, Suggest flow, review list, Apply/
  // Discard) is covered in its own suite, DescribeIt.test.tsx. These tests
  // pin the CONTRACT StudyTypePicker owns: the panel is opt-in via
  // `onApplyDraft`, and it is StudyTypePicker's job to mount or withhold it -
  // never to render it unconditionally the way the dormant shell used to.
  it('renders no AI panel at all when the caller passes no onApplyDraft (the edit route)', () => {
    renderPicker();
    expect(screen.queryByTestId('front-door-ai-prompt')).toBeNull();
  });

  it('mounts the panel when onApplyDraft is provided and drafting is available', async () => {
    vi.mocked(getAiDraftingAvailable).mockResolvedValue(true);
    renderPicker({ onApplyDraft: vi.fn() });

    await waitFor(() => {
      expect(screen.getByTestId('front-door-ai-prompt')).toBeInTheDocument();
    });
    expect(screen.getByLabelText(/What do you want to find out/i)).toBeInTheDocument();
  });

  it('stays hidden when onApplyDraft is provided but drafting is unavailable', async () => {
    vi.mocked(getAiDraftingAvailable).mockResolvedValue(false);
    renderPicker({ onApplyDraft: vi.fn() });

    await waitFor(() => {
      expect(vi.mocked(getAiDraftingAvailable)).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('front-door-ai-prompt')).toBeNull();
  });

  it('does not mount the panel on the locked (published, row-7) view even with onApplyDraft passed', () => {
    vi.mocked(getAiDraftingAvailable).mockResolvedValue(true);
    renderPicker({ type: 'survey', deliveryMode: 'native', isPublished: true, onApplyDraft: vi.fn() });

    expect(screen.queryByTestId('front-door-ai-prompt')).toBeNull();
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

  it('reveals the pods, with a warning, once the author chooses to change', () => {
    renderPicker({ type: 'survey', deliveryMode: 'native', isPublished: true });
    fireEvent.click(screen.getByRole('button', { name: /Change study type/i }));

    // Six pods, plus the delivery toggle's two radios: survey is answer-based
    // and its delivery (native) survives the unlock, so the toggle renders too.
    expect(screen.getAllByRole('radio')).toHaveLength(8);
    expect(screen.getByRole('alert')).toHaveTextContent(/detaches/i);
  });

  it('picks freely when the study is not published', () => {
    renderPicker({ type: '', isPublished: false });
    // No type chosen yet, so it is the six pods alone - no delivery toggle.
    expect(screen.getAllByRole('radio')).toHaveLength(6);
    expect(
      screen.queryByRole('button', { name: /Change study type/i })
    ).toBeNull();
  });
});
