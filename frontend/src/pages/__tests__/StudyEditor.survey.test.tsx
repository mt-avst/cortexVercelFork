import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { StudyEditorForm } from '../StudyEditor';
import { getFirstHandStudyUsage, updateFirstHandStudy } from '../../api/firsthand-studies';

/**
 * Editing a study in the Task Lists area, for both vocabularies.
 *
 * A survey study is created on its opportunity, but it has to remain editable
 * afterwards or it is a type that can be made and never changed. A recorded
 * study keeps its no-type-selector rule and gains the one-way repair for legacy
 * typed steps, which are unanswerable now that the runner renders no inputs.
 */

vi.mock('../../api/firsthand-studies', () => ({
  createFirstHandStudy: vi.fn(),
  updateFirstHandStudy: vi.fn().mockResolvedValue({}),
  getFirstHandStudy: vi.fn(),
  getFirstHandStudyUsage: vi.fn().mockResolvedValue({ count: 0, studies: [] })
}));

// D4: both the recorded and survey editing paths now run through QuestionList,
// which renders a ConfirmationModal for its remove-confirmation dialog - that
// reads useTheme even before the dialog opens. A light stub is enough; this
// suite is not about the palette. Mirrors StudyEditor.test.tsx.
vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false }),
}));

const navigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

const surveyStudy = {
  id: 'study_survey',
  title: 'Developer experience pulse',
  intro_text: 'Ten short questions',
  consent_text: 'Your answers are stored for research analysis.',
  status: 'launched' as const,
  kind: 'survey' as const,
  owner_user_id: 'u1'
};

const recordedStudy = {
  ...surveyStudy,
  id: 'study_recorded',
  title: 'Pipeline triage',
  kind: 'recorded' as const
};

const viewer = { id: 'u1', role: 'researcher_admin' as const };

const ratingStep = {
  step_id: 'study_survey_step_1',
  order: 1,
  type: 'rating' as const,
  prompt: 'How easy was that?',
  config: { scale_max: 7 }
};

const legacyTypedStep = {
  step_id: 'study_recorded_step_1',
  order: 1,
  type: 'open_text' as const,
  prompt: 'What would you change?'
};

beforeEach(() => {
  vi.clearAllMocks();
});

const save = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: /Save changes|Update study/i }));
  await waitFor(() => expect(updateFirstHandStudy).toHaveBeenCalled());
  return vi.mocked(updateFirstHandStudy).mock.calls[0][1] as {
    steps?: Record<string, unknown>[];
  };
};

describe('StudyEditor - a survey study', () => {
  it('offers the survey vocabulary, which a recorded study does not', () => {
    render(
      <StudyEditorForm
        initialStudy={surveyStudy}
        initialSteps={[ratingStep]}
        viewer={viewer}
      />
    );

    // The card starts collapsed; its summary carries the prompt.
    fireEvent.click(screen.getByRole('button', { name: /How easy was that/i }));
    expect(screen.getByLabelText(/^Type$/i)).toBeInTheDocument();
  });

  /**
   * The editor held no `config` at all, so opening a survey study and saving it
   * stripped every rating's scale - and the contract then refuses the save for
   * a field the editor never showed, which makes the study uneditable with no
   * way to see why.
   */
  it('keeps a rating scale through a save that never touched it', async () => {
    const user = userEvent.setup();
    render(
      <StudyEditorForm
        initialStudy={surveyStudy}
        initialSteps={[ratingStep]}
        viewer={viewer}
      />
    );

    const payload = await save(user);

    expect(payload.steps?.[0]).toMatchObject({ config: { scale_max: 7 } });
  });

  it('drops the scale when the question becomes a recommendation score', async () => {
    const user = userEvent.setup();
    render(
      <StudyEditorForm
        initialStudy={surveyStudy}
        initialSteps={[ratingStep]}
        viewer={viewer}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /How easy was that/i }));
    await user.selectOptions(screen.getByLabelText(/^Type$/i), 'nps');

    const payload = await save(user);

    expect(payload.steps?.[0]).not.toHaveProperty('config');
    expect(payload.steps?.[0]).toMatchObject({ type: 'nps' });
  });

  /**
   * `end` is the completion marker every authoring path appends, and it is not
   * in the survey vocabulary - so a Type select bound to it reported
   * "instruction" while the state said "end", offered no way back, and one
   * click permanently retyped it. The runner filters `end` to find the finish,
   * so the study lost its ending and gained a stray page reading "Thanks".
   */
  it('does not offer to retype the completion marker', () => {
    render(
      <StudyEditorForm
        initialStudy={surveyStudy}
        initialSteps={[
          ratingStep,
          {
            step_id: 'study_survey_step_end',
            order: 2,
            type: 'end' as const,
            prompt: 'Thanks - that is the end of the study.'
          }
        ]}
        viewer={viewer}
      />
    );

    // The card starts collapsed; its summary carries the prompt.
    fireEvent.click(screen.getByRole('button', { name: /How easy was that/i }));

    // One selector for the rating question, and none for the marker.
    expect(screen.getAllByLabelText(/^Type$/i)).toHaveLength(1);
  });
});

describe('StudyEditor - a recorded study', () => {
  it('still offers no type selector', async () => {
    render(
      <StudyEditorForm
        initialStudy={recordedStudy}
        initialSteps={[legacyTypedStep]}
        viewer={viewer}
      />
    );
    await waitFor(() => expect(getFirstHandStudyUsage).toHaveBeenCalled());

    expect(screen.queryByLabelText(/^Type$/i)).toBeNull();
  });

  /**
   * D4 supersedes the standalone editor's own one-way "Convert to a spoken
   * instruction" repair: the wizard's Tasks body (`FirstHandStudyTab`, now the
   * ONE editor for both surfaces) never offered a converter for a legacy typed
   * step - it labels the card for what it is and leaves the step, and its
   * options, editable in place. That is now this surface's behaviour too.
   */
  it('labels a legacy typed step for what it is, rather than offering a converter', async () => {
    render(
      <StudyEditorForm
        initialStudy={recordedStudy}
        initialSteps={[legacyTypedStep]}
        viewer={viewer}
      />
    );
    // Let the tab's own usage lookup settle before asserting, so its state
    // update lands inside this test rather than warning after it.
    await waitFor(() => expect(getFirstHandStudyUsage).toHaveBeenCalled());

    expect(screen.getByText(/Typed answer \(legacy\)/i)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Convert to a spoken instruction/i })
    ).toBeNull();
  });

  it('labels an ordinary task as a task, not as legacy', async () => {
    render(
      <StudyEditorForm
        initialStudy={recordedStudy}
        initialSteps={[{ ...legacyTypedStep, type: 'instruction' as const }]}
        viewer={viewer}
      />
    );
    await waitFor(() => expect(getFirstHandStudyUsage).toHaveBeenCalled());

    expect(screen.queryByText(/legacy/i)).toBeNull();
  });

  /**
   * Keeping the step_id is the whole point: delete-and-re-add would orphan
   * every response already stored against it. With no conversion path left,
   * the property that matters is that editing the prompt does not silently
   * drop the rest of a legacy choice step on the way through a save.
   */
  it('keeps a legacy choice step\'s options and identity through a save that never touched them', async () => {
    const user = userEvent.setup();
    render(
      <StudyEditorForm
        initialStudy={recordedStudy}
        initialSteps={[
          {
            ...legacyTypedStep,
            type: 'single_choice' as const,
            options: ['Yes', 'No'],
            // A recorded study with no target anywhere raises the
            // missing-task-page warning, which correctly blocks the save until
            // acknowledged. That guard is not what this test is about.
            target_url: 'https://example.com/checkout'
          }
        ]}
        viewer={viewer}
      />
    );

    const payload = await save(user);

    expect(payload.steps?.[0]).toMatchObject({
      step_id: 'study_recorded_step_1',
      type: 'single_choice',
      options: ['Yes', 'No']
    });
  });
});
