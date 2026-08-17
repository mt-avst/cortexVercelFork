import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { StudyEditorForm } from '../StudyEditor';
import { updateFirstHandStudy } from '../../api/firsthand-studies';

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
  getFirstHandStudy: vi.fn()
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

    // One selector for the rating question, and none for the marker.
    expect(screen.getAllByLabelText(/^Type$/i)).toHaveLength(1);
  });
});

describe('StudyEditor - a recorded study', () => {
  it('still offers no type selector', () => {
    render(
      <StudyEditorForm
        initialStudy={recordedStudy}
        initialSteps={[legacyTypedStep]}
        viewer={viewer}
      />
    );

    expect(screen.queryByLabelText(/^Type$/i)).toBeNull();
  });

  it('offers the one-way repair on a legacy typed step', () => {
    render(
      <StudyEditorForm
        initialStudy={recordedStudy}
        initialSteps={[legacyTypedStep]}
        viewer={viewer}
      />
    );

    expect(
      screen.getByRole('button', { name: /Convert to a spoken instruction/i })
    ).toBeInTheDocument();
  });

  it('does not offer it on a step that is already an instruction', () => {
    render(
      <StudyEditorForm
        initialStudy={recordedStudy}
        initialSteps={[{ ...legacyTypedStep, type: 'instruction' as const }]}
        viewer={viewer}
      />
    );

    expect(
      screen.queryByRole('button', { name: /Convert to a spoken instruction/i })
    ).toBeNull();
  });

  /**
   * Keeping the step_id is the whole point: delete-and-re-add would orphan
   * every response already stored against it.
   */
  it('converts in place, keeping the step id and dropping the options', async () => {
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

    await user.click(
      screen.getByRole('button', { name: /Convert to a spoken instruction/i })
    );

    const payload = await save(user);

    expect(payload.steps?.[0]).toMatchObject({
      step_id: 'study_recorded_step_1',
      type: 'instruction'
    });
    // Asserted on the payload AND on the screen. The payload alone cannot see
    // this clear: stepDraftToPayload only emits options for a choice type, so
    // once the type is an instruction the options are gone whatever the draft
    // holds. The editor no longer offering them is the distinct property.
    expect(payload.steps?.[0]).not.toHaveProperty('options');
    expect(screen.queryByLabelText(/Options \(one per line\)/i)).toBeNull();
  });
});
