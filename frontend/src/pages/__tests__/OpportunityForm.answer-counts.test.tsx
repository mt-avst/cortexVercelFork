import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityForm from '../OpportunityForm';
import { getOpportunity, updateOpportunity } from '../../api/client';
import { getFirstHandStudy } from '../../api/firsthand-studies';
import type { StudyStep } from '@shared/firsthand/contract';

/**
 * What an author is told before a save moves somebody's answers.
 *
 * Before F2, `updateLinkedStudyContent` refused any save that changed the
 * questions of a study which had collected answers, so none of this was
 * reachable. F2 narrows that refusal to type and scale changes - the ones that
 * change what a stored answer MEANS - and deleting a question from a live
 * survey now succeeds: 0015's `ON DELETE SET NULL` detaches the answers rather
 * than destroying them, and they surface under "Removed questions".
 *
 * That behaviour is right and it is strictly better than the old refusal. The
 * gap it leaves is that the author is the one person not told, and the case a
 * per-card dialog structurally cannot cover is the one the review gate raised:
 * an author who deletes every question and adds replacements mints a fresh
 * identity for each new card, so every stored question is absent from the save
 * and every answer detaches - reported as an ordinary success.
 */

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'admin-1', role: 'researcher_admin', name: 'Admin' },
    loading: false
  })
}));
vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'light', isDarkMode: false })
}));
vi.mock('../../components/AdminSessionManager', () => ({ default: () => null }));

vi.mock('../../api/client', () => ({
  createOpportunity: vi.fn(),
  updateOpportunity: vi.fn(),
  getOpportunity: vi.fn(),
  getSessions: vi.fn().mockResolvedValue([]),
  getFirstHandStudies: vi.fn().mockResolvedValue([])
}));

vi.mock('../../api/firsthand-studies', async (importActual) => ({
  ...(await importActual<typeof import('../../api/firsthand-studies')>()),
  getFirstHandStudy: vi.fn()
}));

const surveyOpportunity = {
  id: 'opp-2',
  type: 'survey',
  title: 'Developer experience pulse',
  purpose_one_liner: 'Ten short questions about the tools you use every day',
  description_optional: '',
  product_optional: '',
  status: 'draft',
  default_duration_minutes: 30,
  delivery_mode: 'native',
  firsthand_study_id: 'study_questions',
  participant_type_required: 'any'
};

const SURVEY_STEPS: StudyStep[] = [
  {
    step_id: 'study_questions_q-one',
    order: 1,
    type: 'open_text',
    prompt: 'Which tool slows you down?'
  },
  {
    step_id: 'study_questions_q-two',
    order: 2,
    type: 'open_text',
    prompt: 'What would you change first?'
  },
  { step_id: 'study_questions_step_end', order: 3, type: 'end', prompt: 'Thanks' }
];

/**
 * The stored study, with the counts the API reports beside it.
 *
 * Keyed by STEP KEY - `q-one`, not `study_questions_q-one` - because that is
 * what the route sends and what a question card carries as its `_clientId`.
 * Keying this fixture by the whole id would make every test here pass against a
 * form that had stopped matching them at all.
 */
const study = (answer_counts: Record<string, number> | null | undefined) => ({
  study: {
    id: 'study_questions',
    title: 'Developer experience pulse',
    intro_text: 'Intro',
    consent_text: 'Answers are stored for research analysis',
    kind: 'survey',
    status: 'launched',
    estimated_duration_minutes: 6,
    owner_user_id: 'admin-1',
    updated_at: '2026-08-19T09:30:00.000Z'
  },
  steps: SURVEY_STEPS,
  can_edit: true,
  answer_counts
});

const renderEdit = () =>
  render(
    <MemoryRouter initialEntries={['/admin/opportunities/opp-2/edit']}>
      <Routes>
        <Route path="/admin/opportunities/:id/edit" element={<OpportunityForm />} />
      </Routes>
    </MemoryRouter>
  );

/** Walk forward until there is nowhere left to go, which is Review. */
const walkToReview = () => {
  for (let guard = 0; guard <= 6; guard += 1) {
    const forward = screen.queryByRole('button', { name: /^Continue: /i });
    if (!forward) return;
    fireEvent.click(forward);
  }
  throw new Error('walkToReview never reached a step with no Continue control');
};

const saveFromReview = () => {
  walkToReview();
  fireEvent.click(screen.getByRole('button', { name: /^Save changes$/ }));
};

/**
 * Open the Questions step and wait for the stored questions to arrive.
 *
 * Two controls carry the word once Review has been reached - the step tab and
 * Review's own "Edit Questions" link - so neither can be addressed by a loose
 * match. The Edit link is preferred because it is how an author actually gets
 * back there from Review, which is where every save happens.
 */
const openQuestions = async () => {
  const fromReview = screen.queryByRole('button', { name: /^Edit Questions$/ });
  if (fromReview) {
    fireEvent.click(fromReview);
  } else {
    fireEvent.click(await screen.findByRole('button', { name: /Questions/i }));
  }
  await screen.findByRole('button', { name: 'Remove question 1' });
};

/** How many question cards are on screen, by their own Remove controls. */
const questionCount = () =>
  screen.queryAllByRole('button', { name: /^Remove question \d+$/ }).length;

/**
 * Remove one question, through the per-card confirmation when it asks.
 *
 * Waits on the COUNT rather than on the disappearance of "Remove question N":
 * the controls are numbered by position, so removing the first of two leaves a
 * button with exactly the same accessible name, and a wait for that name to go
 * never returns.
 */
const removeQuestion = async (position: number) => {
  const before = questionCount();
  fireEvent.click(screen.getByRole('button', { name: `Remove question ${position}` }));
  const confirm = screen.queryByRole('button', { name: /^Remove question$/ });
  if (confirm) fireEvent.click(confirm);
  await waitFor(() => expect(questionCount()).toBe(before - 1));
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.mocked(updateOpportunity).mockResolvedValue({ id: 'opp-2' } as never);
  vi.mocked(getOpportunity).mockResolvedValue(surveyOpportunity as never);
});

describe('removing a question people have answered', () => {
  it('names the count in the per-card confirmation', async () => {
    vi.mocked(getFirstHandStudy).mockResolvedValue(
      study({ 'q-one': 47, 'q-two': 3 }) as never
    );

    renderEdit();
    await openQuestions();

    fireEvent.click(screen.getByRole('button', { name: 'Remove question 1' }));

    // Threaded end to end: the route keys by step key, the form holds the same
    // value as `_clientId`, and the card looks its own count up by it. A test
    // of the message alone would pass with the map never reaching the card.
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'Question 1 has collected 47 answers'
    );
  });

  it('sums the consequence once before the save goes through', async () => {
    vi.mocked(getFirstHandStudy).mockResolvedValue(
      study({ 'q-one': 47, 'q-two': 3 }) as never
    );

    renderEdit();
    await openQuestions();
    await removeQuestion(1);

    saveFromReview();

    expect(
      await screen.findByText(/Remove 1 question that has been answered\?/)
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveTextContent('collected 47 answers');
    // The save is held, not merely narrated. A dialog that appears after the
    // request has gone is a notification, not a confirmation.
    expect(updateOpportunity).not.toHaveBeenCalled();
  });

  it('saves once the author confirms', async () => {
    vi.mocked(getFirstHandStudy).mockResolvedValue(
      study({ 'q-one': 47, 'q-two': 3 }) as never
    );

    renderEdit();
    await openQuestions();
    await removeQuestion(1);
    saveFromReview();

    fireEvent.click(
      await screen.findByRole('button', { name: /^Save and remove them$/ })
    );

    await waitFor(() => expect(updateOpportunity).toHaveBeenCalledTimes(1));
    const body = vi.mocked(updateOpportunity).mock.calls[0][1] as {
      inline_survey: { steps: { prompt: string }[] };
    };
    // The payload, not the screen. A confirmation that let the save through
    // while the removed question was still in the body would look identical
    // from the outside and be the exact opposite of what the dialog said.
    expect(body.inline_survey.steps.map((step) => step.prompt)).toEqual([
      'What would you change first?'
    ]);
  });

  it('does not save when the author backs out', async () => {
    vi.mocked(getFirstHandStudy).mockResolvedValue(
      study({ 'q-one': 47, 'q-two': 3 }) as never
    );

    renderEdit();
    await openQuestions();
    await removeQuestion(1);
    saveFromReview();

    fireEvent.click(await screen.findByRole('button', { name: /^Go back$/ }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    );
    expect(updateOpportunity).not.toHaveBeenCalled();
  });

  it('does not carry its authorisation into the next save attempt', async () => {
    // The confirmation authorises ONE save. A flag that survived the attempt
    // would let a later save detach a different set of answers silently,
    // because the author had said yes to something else earlier in the session.
    //
    // Exercised through a save that FAILS, which is both the cheapest way to
    // get two attempts out of one form and a real path: a refused save must
    // leave the author exactly as unauthorised as they were before it.
    vi.mocked(getFirstHandStudy).mockResolvedValue(
      study({ 'q-one': 47, 'q-two': 3 }) as never
    );
    vi.mocked(updateOpportunity).mockRejectedValueOnce(new Error('network'));

    renderEdit();
    await openQuestions();
    await removeQuestion(1);
    saveFromReview();

    fireEvent.click(
      await screen.findByRole('button', { name: /^Save and remove them$/ })
    );
    await waitFor(() => expect(updateOpportunity).toHaveBeenCalledTimes(1));

    // Nothing was removed and nothing was saved, so the same question is still
    // on the form with the same answers behind it.
    fireEvent.click(screen.getByRole('button', { name: /^Save changes$/ }));

    expect(
      await screen.findByRole('button', { name: /^Save and remove them$/ })
    ).toBeInTheDocument();
    expect(updateOpportunity).toHaveBeenCalledTimes(1);
  });

  it('catches an author who replaced every question rather than editing them', async () => {
    // The reviewer's case, and the one no per-card dialog can see: each new
    // card gets a fresh identity, so every stored question is gone from the
    // save and every answer detaches. Individually each removal looked like
    // removing one question.
    vi.mocked(getFirstHandStudy).mockResolvedValue(
      study({ 'q-one': 300, 'q-two': 12 }) as never
    );

    renderEdit();
    await openQuestions();
    await removeQuestion(1);
    await removeQuestion(1);

    fireEvent.click(screen.getByRole('button', { name: /Add question/i }));
    fireEvent.change(screen.getByLabelText(/What the participant is asked/i), {
      target: { value: 'A completely different question' }
    });

    saveFromReview();

    expect(
      await screen.findByText(/Remove 2 questions that have been answered\?/)
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveTextContent('collected 312 answers');
  });

  it('says nothing when the questions removed had no answers', async () => {
    vi.mocked(getFirstHandStudy).mockResolvedValue(
      study({ 'q-two': 3 }) as never
    );

    renderEdit();
    await openQuestions();
    await removeQuestion(1);

    saveFromReview();

    // The ordinary edit this must not interrupt. A warning here is the noise
    // that makes the real one ineffective.
    await waitFor(() => expect(updateOpportunity).toHaveBeenCalledTimes(1));
  });

  it('says nothing when no question was removed at all', async () => {
    vi.mocked(getFirstHandStudy).mockResolvedValue(
      study({ 'q-one': 47, 'q-two': 3 }) as never
    );

    renderEdit();
    // Deliberately WITHOUT opening the Questions step. The title lives on the
    // first step, and this is the save an author makes most often.
    fireEvent.change(await screen.findByDisplayValue('Developer experience pulse'), {
      target: { value: 'Developer experience pulse v2' }
    });
    saveFromReview();

    // Editing the title of a survey with answers is the commonest save there
    // is, and F2 exists partly so it stops being refused.
    await waitFor(() => expect(updateOpportunity).toHaveBeenCalledTimes(1));
  });

  it('refreshes the counts after a save rather than reusing the ones it opened with', async () => {
    // The map is read once at load. Left unrefreshed it goes on naming a
    // question that was removed by the save which made it stale, so every
    // later save in the session re-warns about answers that have already been
    // dealt with - and the author learns to click through the dialog.
    vi.mocked(getFirstHandStudy)
      .mockResolvedValueOnce(study({ 'q-one': 47, 'q-two': 3 }) as never)
      // What the server reports afterwards: q-one is gone, so it is no longer
      // counted, and six more people have answered q-two in the meantime.
      //
      // The NUMBER has to move. An unchanged count for q-two would read the
      // same from the stale map as from the fresh one, so the assertion below
      // would pass against a form that never refreshed at all - which is
      // exactly what it is here to detect.
      .mockResolvedValue(study({ 'q-two': 9 }) as never);

    renderEdit();
    await openQuestions();
    await removeQuestion(1);
    saveFromReview();
    fireEvent.click(
      await screen.findByRole('button', { name: /^Save and remove them$/ })
    );
    await waitFor(() => expect(updateOpportunity).toHaveBeenCalledTimes(1));
    await screen.findByText(/saved as DRAFT/i);

    // The reload returns both stored questions again (the fixture is the study
    // as it was), but the COUNTS are the refreshed ones. Removing the question
    // that still has answers must name 3, not 47.
    await openQuestions();
    fireEvent.click(screen.getByRole('button', { name: 'Remove question 2' }));

    expect(screen.getByRole('dialog')).toHaveTextContent('has collected 9 answers');
    expect(screen.getByRole('dialog')).not.toHaveTextContent('3 answers');
  });

  it('does not ask about a detached save that validation is about to refuse', async () => {
    // The gate runs AFTER validation, and that ordering is load-bearing rather
    // than tidy. A survey cannot be saved with no questions at all, so a form
    // emptied of every question is refused - and the save would have removed
    // nothing, because an empty list sends no inline_survey and the study keeps
    // every question it has. Asking first would promise a removal that cannot
    // happen, on a save that is not going to happen either.
    vi.mocked(getFirstHandStudy).mockResolvedValue(
      study({ 'q-one': 47, 'q-two': 3 }) as never
    );

    renderEdit();
    await openQuestions();
    await removeQuestion(1);
    await removeQuestion(1);

    saveFromReview();

    await screen.findByRole('alert', { name: /There is a problem/i });
    expect(
      screen.queryByRole('button', { name: /^Save and remove them$/ })
    ).not.toBeInTheDocument();
    expect(updateOpportunity).not.toHaveBeenCalled();
  });

  it('does not summarise a recorded task list, whose results have no such section', async () => {
    // The server withholds counts for a recorded study today, and this asserts
    // the form does not depend on that. The save-time gate reads
    // `inline_survey_questions`, which is ALWAYS empty for a recorded
    // opportunity - so a populated map would make every stored key look
    // removed and block every save behind a dialog pointing at a "Removed
    // questions" section this author's results view does not have.
    vi.mocked(getOpportunity).mockResolvedValue({
      ...surveyOpportunity,
      id: 'opp-3',
      type: 'unmoderated',
      delivery_mode: undefined
    } as never);
    vi.mocked(getFirstHandStudy).mockResolvedValue({
      ...study({ 'q-one': 47, 'q-two': 3 }),
      study: { ...study(undefined).study, kind: 'recorded' }
    } as never);

    renderEdit();
    fireEvent.change(await screen.findByDisplayValue('Developer experience pulse'), {
      target: { value: 'Renamed' }
    });
    saveFromReview();

    await waitFor(() => expect(updateOpportunity).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByRole('button', { name: /^Save and remove them$/ })
    ).not.toBeInTheDocument();
  });

  it('stops trusting its counts once a colleague has written the study', async () => {
    /*
     * The one path that is refused and deliberately does NOT reload, so the
     * author's unsaved work survives it - and the one path where the map is
     * provably out of date, because somebody else wrote this study since it was
     * read. A question they added, and the answers it has since collected, are
     * in neither the map nor this form's cards. The next save is the deliberate
     * overwrite F1 exists to offer, and it would detach those answers with no
     * per-card dialog and no summary, on the very save the conflict banner has
     * just called contentious.
     */
    vi.mocked(getFirstHandStudy).mockResolvedValue(
      study({ 'q-one': 47, 'q-two': 3 }) as never
    );
    vi.mocked(updateOpportunity).mockRejectedValueOnce(
      Object.assign(new Error('conflict'), {
        response: {
          status: 409,
          data: { error: 'stale_study', current_updated_at: '2026-08-21T10:00:00.000Z' }
        }
      })
    );

    renderEdit();
    await openQuestions();
    await removeQuestion(1);
    saveFromReview();
    fireEvent.click(
      await screen.findByRole('button', { name: /^Save and remove them$/ })
    );
    await waitFor(() => expect(updateOpportunity).toHaveBeenCalledTimes(1));

    // The counts are now disowned, so the surviving question reports unknown
    // rather than the 3 the pre-conflict map claimed.
    await openQuestions();
    fireEvent.click(screen.getByRole('button', { name: 'Remove question 1' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('could not be checked');
    expect(dialog).not.toHaveTextContent('has collected');
  });

  it('still summarises a removal when the count could not be read', async () => {
    /*
     * This test used to assert the opposite, and asserting the opposite was the
     * bug. `answersDetachedBy` derived everything from the counts map, so an
     * unreadable map meant an empty removal list and no dialog at all - the one
     * warning that covers the case no per-card dialog can, disappearing exactly
     * when the database is under pressure.
     *
     * What cannot be enumerated is HOW MANY ANSWERS. WHICH QUESTIONS is known
     * from the stored identities either way.
     */
    vi.mocked(getFirstHandStudy).mockResolvedValue(study(null) as never);

    renderEdit();
    await openQuestions();

    fireEvent.click(screen.getByRole('button', { name: 'Remove question 1' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('could not be checked');
    fireEvent.click(screen.getByRole('button', { name: /^Remove question$/ }));

    saveFromReview();

    expect(
      await screen.findByText(/Remove 1 question that may have been answered\?/)
    ).toBeInTheDocument();
    // Claims only what it knows: a removal, not a number of answers.
    expect(screen.getByRole('dialog')).not.toHaveTextContent('collected');
    expect(updateOpportunity).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /^Save and remove them$/ }));
    await waitFor(() => expect(updateOpportunity).toHaveBeenCalledTimes(1));
  });

  it('does not warn about an unreadable count when nothing stored is removed', async () => {
    // The other half of failing closed. An unreadable count on a save that
    // removes nothing must stay silent, or every save of a study whose counts
    // happen to be unavailable carries a dialog nobody needs.
    vi.mocked(getFirstHandStudy).mockResolvedValue(study(null) as never);

    renderEdit();
    fireEvent.change(await screen.findByDisplayValue('Developer experience pulse'), {
      target: { value: 'Developer experience pulse v2' }
    });
    saveFromReview();

    await waitFor(() => expect(updateOpportunity).toHaveBeenCalledTimes(1));
  });
});
