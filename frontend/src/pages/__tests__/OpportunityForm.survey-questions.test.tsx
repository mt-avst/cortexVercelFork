import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityForm, { getTabsForType } from '../OpportunityForm';
import { SURVEY_CONSENT_TEMPLATE } from '@shared/firsthand/consent-templates';
import { createOpportunity, getFirstHandStudies, getOpportunity, updateOpportunity } from '../../api/client';
import { getFirstHandStudy } from '../../api/firsthand-studies';
import { inlineErrorText, summarisedErrorKeys } from './helpers/error-summary';

/**
 * The shape of an identity minted for a question that has never been saved.
 *
 * A v4 uuid from `mintClientId`, matched rather than compared, because the
 * value is random by design. Written as a pattern rather than `expect.any
 * (String)` so that the positional fallback - `step_1`, the very thing F2
 * replaced - would fail it.
 */
const A_MINTED_IDENTITY = expect.stringMatching(
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
);

/**
 * Authoring a native poll or survey on the opportunity form.
 *
 * Polls and surveys were external-link-only, so the third tab was always
 * "External Link". Which tab appears now depends on where the participant
 * answers, and the questions written there have to reach the API in the shape
 * the contract accepts - a payload that fails server-side is the failure this
 * form exists to prevent.
 */

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', role: 'researcher_admin', name: 'R' },
    loading: false
  })
}));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));

vi.mock('../../api/client', () => ({
  createOpportunity: vi.fn().mockResolvedValue({ id: 'new-1' }),
  updateOpportunity: vi.fn().mockResolvedValue({ id: 'opp-1' }),
  getOpportunity: vi.fn(),
  getFirstHandStudies: vi.fn(async () => []),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  getSessions: vi.fn(async () => [])
}));

/**
 * The single-study getter edit mode uses to read back what the author wrote.
 *
 * Resolves a survey-kind study with one question, because every edit-mode
 * fixture in this file links one. Without a stub the real module runs, the
 * fetch fails, and the form refuses to save at all - which is the correct
 * behaviour for an unreadable study and a very confusing test failure.
 */
vi.mock('../../api/firsthand-studies', async (importActual) => ({
  ...(await importActual<typeof import('../../api/firsthand-studies')>()),
  getFirstHandStudy: vi.fn(async () => ({
    study: {
      id: 'study_questions',
      title: 'Developer experience pulse',
      intro_text: 'Intro',
      consent_text: 'Answers are stored for research analysis',
      kind: 'survey',
      status: 'launched',
      estimated_duration_minutes: null,
      owner_user_id: 'u1',
      updated_at: '2026-08-19T00:00:00.000Z'
    },
    steps: [
      { step_id: 'study_questions_step_1', order: 1, type: 'open_text', prompt: 'Which tool slows you down?' },
      { step_id: 'study_questions_step_end', order: 2, type: 'end', prompt: 'Thanks' }
    ],
    can_edit: true
  }))
}));

const renderForm = () =>
  render(
    <MemoryRouter initialEntries={['/admin/opportunities/new']}>
      <Routes>
        <Route path="/admin/opportunities/new" element={<OpportunityForm />} />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  vi.clearAllMocks();
});


/**
 * Walk forward until there is nowhere left to go, which is Review.
 *
 * Clicks whatever "Continue: {step}" the current step offers, repeatedly. A
 * loop rather than a fixed number of clicks because the shapes are three, four
 * and five steps long, and a count cannot help stopping one step short when a
 * shape changes - which is the whole failure mode this helper exists to keep
 * out of thirty-odd call sites.
 *
 * The bound guards against a Continue control that renders but does not
 * advance: without it that spins forever instead of failing.
 */
const walkToReview = async (user: ReturnType<typeof userEvent.setup>) => {
  for (let guard = 0; guard <= 6; guard += 1) {
    const forward = screen.queryByRole('button', { name: /^Continue: /i });
    if (!forward) {
      return;
    }
    await user.click(forward);
  }
  throw new Error('walkToReview never reached a step with no Continue control');
};

/**
 * Choose Status from Review (#111 moved the control off Basic Information).
 *
 * Review has no `<label htmlFor="status">` any more - only an
 * `<h3>Status</h3>` heading - so it is the one `<select>` Review renders,
 * found by role rather than by name. Callers must reach Review first (e.g.
 * via `walkToReview`).
 */
const setStatus = async (user: ReturnType<typeof userEvent.setup>, status: string) => {
  await user.selectOptions(
    within(screen.getByTestId('review-step')).getByRole('combobox'),
    status
  );
};

/**
 * Click the create/save control, walking every remaining step to Review first.
 *
 * Review is where every save happens now (C3), so this always walks whatever
 * distance is left via `walkToReview` before clicking the terminal control.
 */
const submitFromLastStep = async (
  user: ReturnType<typeof userEvent.setup>,
  name: RegExp = /^(Create study|Save changes)$/
) => {
  await walkToReview(user);
  await user.click(screen.getByRole('button', { name }));
};

describe('getTabsForType', () => {
  it('offers the external link tab when a survey hands off', () => {
    expect(getTabsForType('survey', 'external').map((tab) => tab.title)).toEqual([
      'Basic Information',
      'Content & Details',
      'External Link',
      'Screener',
      'Consent',
      'Review'
    ]);
  });

  it('offers the questions tab when a survey runs in Cortex', () => {
    expect(getTabsForType('survey', 'native').map((tab) => tab.title)).toEqual([
      'Basic Information',
      'Content & Details',
      'Questions',
      'Screener',
      'Consent',
      'Review'
    ]);
  });

  /**
   * WZ-18 (Decision 9): every question-carrying type now carries a Consent step
   * whichever way it is delivered, so the step count stops jumping between four
   * and five as the author toggles delivery mode. A native survey's Consent step
   * edits the wording Cortex will show; an external survey's is a short
   * confirmation that the tool on the other side of the link carries consent.
   * `toEqual` on the whole array rather than `toContain`, because the failure
   * that matters is a MISSING or misplaced step, and `toContain` cannot see one.
   */
  it('gives an externally delivered survey a confirmation Consent step, so the count matches the native shape', () => {
    expect(getTabsForType('survey', 'external').map((tab) => tab.title)).toEqual([
      'Basic Information',
      'Content & Details',
      'External Link',
      'Screener',
      'Consent',
      'Review'
    ]);
  });

  it('gives a recorded study a consent step, last before Review', () => {
    expect(getTabsForType('unmoderated').map((tab) => tab.title)).toEqual([
      'Basic Information',
      'Content & Details',
      'Task List',
      'Screener',
      'Consent',
      'Review'
    ]);
  });

  /**
   * WZ-18 (Decision 9): a handed-off question now carries a Consent step too - a
   * short confirmation that the external tool holds the consent, so the wizard is
   * five steps for every question-carrying type rather than four for a hand-off
   * and five for a native run. `question` defaults to external delivery.
   */
  it('gives a handed-off question a confirmation Consent step, so its count matches the native question', () => {
    expect(getTabsForType('question').map((tab) => tab.title)).toEqual([
      'Basic Information',
      'Content & Details',
      'External Link',
      'Screener',
      'Consent',
      'Review'
    ]);
  });

  it.each([['test'], ['interview']])(
    'gives %s a consent step, because Cortex stores what it agrees to keep (#79)',
    (type) => {
      expect(getTabsForType(type).map((tab) => tab.title)).toEqual([
        'Basic Information',
        'Content & Details',
        'Session Management',
        'Screener',
        'Consent',
        'Review'
      ]);
    }
  );

  it('defaults to the external link tab, which is what every existing poll is', () => {
    expect(getTabsForType('poll').map((tab) => tab.title)).toContain('External Link');
  });

  /**
   * #78 replaced this test's premise rather than its assertion.
   *
   * It used to read "leaves the one-question type on the external link tab",
   * because `question` had no native runner and kept the link step whatever
   * the delivery mode said. It has one now - SurveyRunner, the same one a
   * poll and a survey use - so the two shapes below are what it must have,
   * and the pairing is the point: whole-array equality, because the failure
   * that matters is a step that should have been swapped appearing alongside
   * its replacement rather than instead of it.
   */
  it('keeps the external link tab when a question hands off, which is every existing one', () => {
    expect(getTabsForType('question', 'external').map((tab) => tab.title)).toEqual([
      'Basic Information',
      'Content & Details',
      'External Link',
      'Screener',
      'Consent',
      'Review'
    ]);
  });

  it('offers the question tab, and a consent step, when a question runs in Cortex', () => {
    expect(getTabsForType('question', 'native').map((tab) => tab.title)).toEqual([
      'Basic Information',
      'Content & Details',
      // Singular. The type's whole promise is that there is one.
      'Question',
      'Screener',
      'Consent',
      'Review'
    ]);
  });

  /**
   * The default matters more here than for a poll: `delivery_mode` is absent
   * on every `question` row stored before #78, and the column defaults to
   * external. If the default flipped, those rows would lose the link step that
   * is the only way their participants reach the study.
   */
  it('defaults a question to handing off, which is what every stored one does', () => {
    expect(getTabsForType('question').map((tab) => tab.title)).toContain(
      'External Link'
    );
  });

  it('leaves a recorded study on its task list', () => {
    expect(getTabsForType('unmoderated', 'native').map((tab) => tab.title)).toContain(
      'Task List'
    );
  });
});

describe("the hand-off Consent step confirms the external tool's consent (WZ-18)", () => {
  const openExternalPollConsent = async (
    user: ReturnType<typeof userEvent.setup>
  ) => {
    await user.selectOptions(screen.getByLabelText(/Research Study Type/i), 'poll');
    await user.type(screen.getByLabelText(/^Title/i), 'How was the export flow');
    await user.type(
      screen.getByLabelText(/^Purpose/i),
      'One quick question after someone exports their data'
    );
    await user.click(screen.getByRole('button', { name: /^Continue: Content & Details$/ }));
    await user.click(screen.getByRole('button', { name: /^Continue: External Link$/ }));
    await user.click(screen.getByRole('button', { name: /^Continue: Screener$/ }));
    await user.click(screen.getByRole('button', { name: /^Continue: Consent$/ }));
  };

  it('shows a short confirmation, not a consent-wording editor', async () => {
    const user = userEvent.setup();
    renderForm();
    await openExternalPollConsent(user);

    // The confirmation body, keyed by its own testid so it cannot be confused
    // with the editing ConsentStep the native/moderated shapes render.
    const step = await screen.findByTestId('external-consent-step');
    expect(step).toHaveTextContent(/consent is\s+collected there, not in Cortex/i);
    expect(step).toHaveTextContent(/Confirm the tool.s own\s+consent text is in place before you publish/i);
    expect(
      within(step).getByRole('heading', { name: /Consent/i })
    ).toBeInTheDocument();

    // And NONE of the editor: no wording textarea, no template chooser, no
    // ConsentStep at all. A hand-off has no wording of its own to edit, and
    // offering one would imply Cortex governs consent it does not hold.
    expect(screen.queryByTestId('consent-step')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Consent text/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Customise consent wording/i })
    ).not.toBeInTheDocument();
  });

  it('sends nothing consent-shaped when a hand-off is created through the confirmation step', async () => {
    // The confirmation step writes no consent fields - it only confirms - so a
    // created external poll must carry no moderated/inline consent wording.
    const user = userEvent.setup();
    renderForm();
    await openExternalPollConsent(user);
    await user.click(screen.getByRole('button', { name: /^Continue: Review$/ }));
    await user.click(screen.getByRole('button', { name: /^Create study$/ }));

    await waitFor(() => expect(vi.mocked(createOpportunity)).toHaveBeenCalled());
    const sent = vi.mocked(createOpportunity).mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(sent.moderated_consent_text).toBeFalsy();
    expect(sent.inline_survey_consent_text).toBeFalsy();
    expect(sent.inline_study_consent_text).toBeFalsy();
  });
});

describe('authoring a native survey', () => {
  const fillBasics = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.selectOptions(screen.getByLabelText(/Research Study Type/i), 'survey');
    await user.type(screen.getByLabelText(/^Title/i), 'Developer experience pulse');
    await user.type(
      screen.getByLabelText(/^Purpose/i),
      'Ten short questions about the tools you use every day'
    );
  };

  it('does not offer the delivery choice for a type that has no external mode', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.selectOptions(
      screen.getByLabelText(/Research Study Type/i),
      'unmoderated'
    );

    expect(screen.queryByText(/Where participants answer/i)).toBeNull();
  });

  /**
   * #78: the one-question type, end to end through the form.
   *
   * Driven rather than asserted on `getTabsForType`, because the step shape
   * being right proves nothing about the payload: the failure this replaces
   * was a type whose only third step handed off, so what has to be checked is
   * that a question authored here actually leaves as `inline_survey` with
   * native delivery.
   */
  describe('a one-question opportunity', () => {
    const fillQuestionBasics = async (
      user: ReturnType<typeof userEvent.setup>
    ) => {
      await user.selectOptions(
        screen.getByLabelText(/Research Study Type/i),
        'question'
      );
      await user.type(screen.getByLabelText(/^Title/i), 'One thing');
      await user.type(
        screen.getByLabelText(/^Purpose/i),
        'A single question about the thing you just tried'
      );
    };

    it('offers the delivery choice, which it never used to have', async () => {
      const user = userEvent.setup();
      renderForm();

      await user.selectOptions(
        screen.getByLabelText(/Research Study Type/i),
        'question'
      );

      expect(screen.getByText(/Where participants answer/i)).toBeInTheDocument();
    });

    it('sends the authored question as inline_survey, natively delivered', async () => {
      const user = userEvent.setup();
      renderForm();
      await fillQuestionBasics(user);
      await user.click(screen.getByLabelText(/In Cortex/i));

      await user.click(screen.getByRole('button', { name: /Question/i }));
      await user.click(screen.getByRole('button', { name: /^Add question$/i }));

      await user.type(
        screen.getByLabelText(/What the participant is asked/i),
        'What nearly stopped you?'
      );

      await submitFromLastStep(user, /^Create study$/);

      await waitFor(() => expect(createOpportunity).toHaveBeenCalled());

      const body = vi.mocked(createOpportunity).mock.calls[0][0] as {
        delivery_mode?: string;
        inline_survey?: { steps: { type: string; prompt: string }[] };
      };

      expect(body.delivery_mode).toBe('native');
      expect(body.inline_survey?.steps).toEqual([
        {
          step_key: A_MINTED_IDENTITY,
          type: 'open_text',
          prompt: 'What nearly stopped you?'
        }
      ]);
    });

    /**
     * The cap, where the author meets it. Hidden rather than disabled: there
     * is nothing they can do on this screen to raise it, so a control that
     * invites a click and then refuses is worse than no control.
     *
     * The control is the survey case below - the same list, same component,
     * keeps offering the button after one question - without which this test
     * passes just as well when the button never renders at all.
     */
    it('stops offering another question once it has its one', async () => {
      const user = userEvent.setup();
      renderForm();
      await fillQuestionBasics(user);
      await user.click(screen.getByLabelText(/In Cortex/i));
      await user.click(screen.getByRole('button', { name: /Question/i }));

      await user.click(screen.getByRole('button', { name: /^Add question$/i }));

      await waitFor(() =>
        expect(screen.queryByRole('button', { name: /^Add question$/i })).toBeNull()
      );
    });

    it('keeps offering another question on a survey, which has no such cap', async () => {
      const user = userEvent.setup();
      renderForm();
      await fillBasics(user);
      await user.click(screen.getByLabelText(/In Cortex/i));
      await user.click(screen.getByRole('button', { name: /Questions/i }));

      await user.click(screen.getByRole('button', { name: /^Add question$/i }));

      expect(
        screen.getByRole('button', { name: /^Add question$/i })
      ).toBeInTheDocument();
    });
  });

  it('swaps the third tab when the author chooses to run it in Cortex', async () => {
    const user = userEvent.setup();
    renderForm();
    await fillBasics(user);

    expect(screen.getByText('External Link')).toBeInTheDocument();

    await user.click(screen.getByLabelText(/In Cortex/i));

    await waitFor(() => expect(screen.getByText('Questions')).toBeInTheDocument());
    expect(screen.queryByText('External Link')).toBeNull();
  });

  /**
   * The whole point of the tab: the questions have to arrive at the API as
   * `inline_survey`, in the contract's shape. This asserts on the request body
   * rather than on form state, because state proves nothing about what was
   * sent - the failure mode that lost every survey answer before 7.36.2 was
   * exactly a value that looked right until it crossed a boundary.
   */
  it('sends the authored questions as inline_survey', async () => {
    const user = userEvent.setup();
    renderForm();
    await fillBasics(user);
    await user.click(screen.getByLabelText(/In Cortex/i));

    await user.click(screen.getByRole('button', { name: /Questions/i }));
    await user.click(screen.getByRole('button', { name: /^Add question$/i }));

    await user.type(
      screen.getByLabelText(/What the participant is asked/i),
      'How easy was that?'
    );

    await submitFromLastStep(user, /^Create study$/);

    await waitFor(() => expect(createOpportunity).toHaveBeenCalled());

    const body = vi.mocked(createOpportunity).mock.calls[0][0] as {
      delivery_mode?: string;
      inline_survey?: { steps: { type: string; prompt: string }[] };
    };

    expect(body.delivery_mode).toBe('native');
    expect(body.inline_survey?.steps).toEqual([
      // A brand new question, so its identity is freshly MINTED - a uuid, not
      // a position. This is what makes the stored step id stable across every
      // later reorder.
      { step_key: A_MINTED_IDENTITY, type: 'open_text', prompt: 'How easy was that?' }
    ]);
  });

  /**
   * The survey twin of the payload-claim assertions on the recorded path, and
   * it fails differently: `inlineSurveySchema` is `.strict()`, so a claim this
   * form sends and that schema does not declare is a refused save rather than a
   * dropped field. Both directions are worth pinning here.
   */
  it('sends the consent template the wording is actually on', async () => {
    const user = userEvent.setup();
    renderForm();
    await fillBasics(user);
    await user.click(screen.getByLabelText(/In Cortex/i));

    await user.click(screen.getByRole('button', { name: /Questions/i }));
    await user.click(screen.getByRole('button', { name: /^Add question$/i }));
    await user.type(
      screen.getByLabelText(/What the participant is asked/i),
      'How easy was that?'
    );

    await submitFromLastStep(user, /^Create study$/);
    await waitFor(() => expect(createOpportunity).toHaveBeenCalled());

    const body = vi.mocked(createOpportunity).mock.calls[0][0] as {
      inline_survey?: { consent_template_id?: string; consent_template_version?: number };
    };
    expect(body.inline_survey?.consent_template_id).toBe('survey-default');
    expect(body.inline_survey?.consent_template_version).toBe(1);
  });

  it('sends no template claim once the author has customised the survey wording', async () => {
    const user = userEvent.setup();
    renderForm();
    await fillBasics(user);
    await user.click(screen.getByLabelText(/In Cortex/i));

    await user.click(screen.getByRole('button', { name: /Questions/i }));
    await user.click(screen.getByRole('button', { name: /^Add question$/i }));
    await user.type(
      screen.getByLabelText(/What the participant is asked/i),
      'How easy was that?'
    );

    await user.click(screen.getByRole('button', { name: /^Continue: Screener$/i }));
    await user.click(screen.getByRole('button', { name: /^Continue: Consent$/i }));
    await user.click(
      screen.getByRole('button', { name: /Customise consent wording/i })
    );
    await user.clear(screen.getByLabelText(/Consent text/i));
    await user.type(screen.getByLabelText(/Consent text/i), 'Our own survey wording');
    await walkToReview(user);
    await user.click(screen.getByRole('button', { name: /^Create study$/ }));

    await waitFor(() => expect(createOpportunity).toHaveBeenCalled());

    const inline = (
      vi.mocked(createOpportunity).mock.calls[0][0] as {
        inline_survey?: Record<string, unknown>;
      }
    ).inline_survey as Record<string, unknown>;

    expect(inline.consent_text).toBe('Our own survey wording');
    expect('consent_template_id' in inline).toBe(false);
    expect('consent_template_version' in inline).toBe(false);
  });

  /**
   * The lock, on the survey path. Asserted separately from the recorded path's
   * identical assertion: a lock applied on one twin and not the other is this
   * project's most repeated defect, and the two consent surfaces were separate
   * copies of the same markup until C1 replaced them with one component.
   */
  it('opens the consent step locked to the approved survey wording', async () => {
    const user = userEvent.setup();
    renderForm();
    await fillBasics(user);
    await user.click(screen.getByLabelText(/In Cortex/i));

    await user.click(screen.getByRole('button', { name: /Questions/i }));
    await user.click(screen.getByRole('button', { name: /^Add question$/i }));
    await user.click(screen.getByRole('button', { name: /^Continue: Screener$/i }));
    await user.click(screen.getByRole('button', { name: /^Continue: Consent$/i }));

    expect(await screen.findByTestId('consent-template-state')).toHaveTextContent(
      'Standard survey consent (version 1)'
    );
    expect(screen.getByTestId('consent-locked-text')).toHaveTextContent(
      /Nothing is recorded/i
    );
    expect(screen.queryByLabelText(/Consent text/i)).not.toBeInTheDocument();
  });

  /**
   * A rating's scale left on a question the author switched to a recommendation
   * score is REJECTED by the contract - that type is fixed at 0 to 10 and takes
   * no scale - so a leftover fails the save with an error about a field the
   * form is no longer showing.
   *
   * B2 stopped answering that by deleting the author's settings on every type
   * change, which threw away four hand-written answers if they touched the
   * selector by mistake. The settings are kept in state now and stripped by
   * `toSurveyPayloadStep` instead, so this test has to drive the REAL payload
   * builder: a state-only assertion proves nothing, because state is exactly
   * where the leftover now legitimately lives.
   */
  it('drops a rating scale when the question becomes a recommendation score', async () => {
    const user = userEvent.setup();
    renderForm();
    await fillBasics(user);
    await user.click(screen.getByLabelText(/In Cortex/i));

    await user.click(screen.getByRole('button', { name: /Questions/i }));
    await user.click(screen.getByRole('button', { name: /^Add question$/i }));
    await user.type(
      screen.getByLabelText(/What the participant is asked/i),
      'How easy was that?'
    );

    await user.selectOptions(screen.getByLabelText(/^Type$/i), 'rating');
    await waitFor(() =>
      expect(screen.getByLabelText(/Points on the scale/i)).toBeInTheDocument()
    );

    await user.selectOptions(screen.getByLabelText(/^Type$/i), 'nps');

    await submitFromLastStep(user, /^Create study$/);
    await waitFor(() => expect(createOpportunity).toHaveBeenCalled());

    const body = vi.mocked(createOpportunity).mock.calls[0][0] as {
      inline_survey?: { steps: Record<string, unknown>[] };
    };

    expect(body.inline_survey?.steps[0]).toEqual({
      step_key: A_MINTED_IDENTITY,
      type: 'nps',
      prompt: 'How easy was that?'
    });
  });

  /**
   * The other half of the same behaviour, and the half a state-only test would
   * miss: what was preserved has to come BACK, and the save that carries it has
   * to succeed. Asserted on the payload for both reasons.
   */
  it('gives the scale back when the question becomes a rating again', async () => {
    const user = userEvent.setup();
    renderForm();
    await fillBasics(user);
    await user.click(screen.getByLabelText(/In Cortex/i));

    await user.click(screen.getByRole('button', { name: /Questions/i }));
    await user.click(screen.getByRole('button', { name: /^Add question$/i }));
    await user.type(
      screen.getByLabelText(/What the participant is asked/i),
      'How easy was that?'
    );

    await user.selectOptions(screen.getByLabelText(/^Type$/i), 'rating');
    await user.clear(await screen.findByLabelText(/Points on the scale/i));
    await user.type(screen.getByLabelText(/Points on the scale/i), '7');

    await user.selectOptions(screen.getByLabelText(/^Type$/i), 'nps');
    await user.selectOptions(screen.getByLabelText(/^Type$/i), 'rating');

    await submitFromLastStep(user, /^Create study$/);
    await waitFor(() => expect(createOpportunity).toHaveBeenCalled());

    const body = vi.mocked(createOpportunity).mock.calls[0][0] as {
      inline_survey?: { steps: Record<string, unknown>[] };
    };

    // 7, not the default 5. A re-seeded scale would look like preservation and
    // would silently change the data every study on it produces.
    expect(body.inline_survey?.steps[0]).toEqual({
      step_key: A_MINTED_IDENTITY,
      type: 'rating',
      prompt: 'How easy was that?',
      config: { scale_max: 7 }
    });
  });

  /**
   * The case the plan names: four answers, away to a type that cannot show
   * them, and back. It used to come back as two empty rows.
   */
  it('gives written answers back after a trip through free text', async () => {
    const user = userEvent.setup();
    renderForm();
    await fillBasics(user);
    await user.click(screen.getByLabelText(/In Cortex/i));

    await user.click(screen.getByRole('button', { name: /Questions/i }));
    await user.click(screen.getByRole('button', { name: /^Add question$/i }));
    await user.type(
      screen.getByLabelText(/What the participant is asked/i),
      'Which delivery option would you pick?'
    );

    await user.selectOptions(screen.getByLabelText(/^Type$/i), 'single_choice');
    await user.type(
      await screen.findByLabelText('Answer 1 for question 1'),
      'Standard'
    );
    await user.type(screen.getByLabelText('Answer 2 for question 1'), 'Next day');

    await user.selectOptions(screen.getByLabelText(/^Type$/i), 'open_text');
    await user.selectOptions(screen.getByLabelText(/^Type$/i), 'single_choice');

    await submitFromLastStep(user, /^Create study$/);
    await waitFor(() => expect(createOpportunity).toHaveBeenCalled());

    const body = vi.mocked(createOpportunity).mock.calls[0][0] as {
      inline_survey?: { steps: Record<string, unknown>[] };
    };

    expect(body.inline_survey?.steps[0]).toEqual({
      step_key: A_MINTED_IDENTITY,
      type: 'single_choice',
      prompt: 'Which delivery option would you pick?',
      options: ['Standard', 'Next day']
    });
  });

  /**
   * Errors are keyed by position, so the form used to delete every one of them
   * on any change to the list. Moving a question the author had not yet fixed
   * silently cleared the reason they were sent back to it, and the next save
   * refused for exactly the same thing.
   */
  it('keeps a question error pointing at its question across a move', async () => {
    const user = userEvent.setup();
    renderForm();
    await fillBasics(user);
    await user.click(screen.getByLabelText(/In Cortex/i));

    await user.click(screen.getByRole('button', { name: /Questions/i }));
    await user.click(screen.getByRole('button', { name: /^Add question$/i }));
    await user.type(
      screen.getByLabelText(/What the participant is asked/i),
      'Which tool slows you down?'
    );
    // Added second and left empty, so exactly one question is refused and the
    // one that survives the move is identifiable.
    await user.click(screen.getByRole('button', { name: /^Add question$/i }));

    await submitFromLastStep(user, /^Create study$/);
    await screen.findByRole('alert', { name: /There is a problem/i });
    // The message is NUMBERED now, which is what makes a summary of six empty
    // questions readable - and what makes this assertion able to tell which
    // question the error is about without counting cards.
    expect(summarisedErrorKeys()).toEqual(['inline_survey_questions.1.prompt']);
    expect(
      inlineErrorText('Enter the text for question 2')
    ).toBeInTheDocument();
    expect(createOpportunity).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Move question 2 up' }));

    // Still there, and now on the FIRST card - which is where the empty
    // question went. Asserting only that it survived would pass against an
    // error left behind on the question the author already filled in.
    //
    // And RENUMBERED. This block used to assert that the message kept its
    // ORIGINAL number, on the stated grounds that re-deriving it "would need a
    // save" - which was untrue, and enshrined a real defect: after this very
    // move, the card labelled "1." read "Enter the text for question 2". The
    // number is a placeholder resolved from the error KEY, and
    // `remapAuthoringErrors` rewrites that key when the item moves, so both the
    // card and the summary say 1.
    //
    // Scoped to the question list. The error summary renders `<li>` entries of
    // its own, so an unscoped listitem query returns the summary's items FIRST
    // and every index below shifts.
    const cards = within(
      screen.getByRole('list', { name: /questions in this list/i })
    ).getAllByRole('listitem');
    expect(
      within(cards[0]).getByText('Enter the text for question 1')
    ).toBeInTheDocument();
    expect(
      within(cards[1]).queryByText(/Enter the text for question/i)
    ).toBeNull();
    // The stale number is nowhere on screen.
    expect(screen.queryAllByText('Enter the text for question 2')).toEqual([]);
  });

  /**
   * An empty list has no length, and the sentence that described one read
   * "Automatically estimated from your 0 questions" - a broken sentence about
   * a number that is not there.
   */
  it('says there is nothing to estimate before any question is written', async () => {
    const user = userEvent.setup();
    renderForm();
    await fillBasics(user);
    await user.click(screen.getByLabelText(/In Cortex/i));
    await user.click(screen.getByRole('button', { name: /Questions/i }));

    expect(screen.getByText(/nothing to estimate from yet/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Estimated completion time/i)).toHaveValue(null);

    await user.click(screen.getByRole('button', { name: /^Add question$/i }));

    expect(screen.queryByText(/nothing to estimate from yet/i)).toBeNull();
    expect(screen.getByText(/Automatically estimated/i)).toBeInTheDocument();
  });

  /**
   * The survey half of the automatic estimate, asserted at the PAYLOAD.
   *
   * The task-list half has its own test, and one covering both is exactly the
   * shape that lets a copy-paste of the wrong field name past a review: the two
   * branches are textually near-identical and neither is derived from the
   * other. Thirty seconds of consent plus sixty for a free-text answer, rounded
   * up to a whole minute.
   */
  it('sends the automatic estimate for a survey nobody set a length on', async () => {
    const user = userEvent.setup();
    renderForm();
    await fillBasics(user);
    await user.click(screen.getByLabelText(/In Cortex/i));

    await user.click(screen.getByRole('button', { name: /Questions/i }));
    await user.click(screen.getByRole('button', { name: /^Add question$/i }));
    await user.type(
      screen.getByLabelText(/What the participant is asked/i),
      'Which tool slows you down?'
    );

    await submitFromLastStep(user, /^Create study$/);
    await waitFor(() => expect(createOpportunity).toHaveBeenCalled());

    const body = vi.mocked(createOpportunity).mock.calls[0][0] as {
      inline_survey?: { estimated_duration_minutes?: number | null };
    };

    expect(body.inline_survey?.estimated_duration_minutes).toBe(2);
  });

  /**
   * An instruction cannot be answered, so a required flag on one is hidden
   * state that crosses the API and is stored meaning nothing. The contract does
   * NOT refuse it, so nothing downstream would ever complain - which is exactly
   * why the rule needs a test rather than a comment.
   */
  it('drops the required flag when a question becomes section text', async () => {
    const user = userEvent.setup();
    renderForm();
    await fillBasics(user);
    await user.click(screen.getByLabelText(/In Cortex/i));

    await user.click(screen.getByRole('button', { name: /Questions/i }));
    await user.click(screen.getByRole('button', { name: /^Add question$/i }));
    await user.type(
      screen.getByLabelText(/What the participant is asked/i),
      'Before we start, a note about how this works'
    );
    await user.click(screen.getByLabelText('Required'));
    await user.selectOptions(screen.getByLabelText(/^Type$/i), 'instruction');

    await submitFromLastStep(user, /^Create study$/);
    await waitFor(() => expect(createOpportunity).toHaveBeenCalled());

    const body = vi.mocked(createOpportunity).mock.calls[0][0] as {
      inline_survey?: { steps: Record<string, unknown>[] };
    };

    expect(body.inline_survey?.steps[0]).toEqual({
      step_key: A_MINTED_IDENTITY,
      type: 'instruction',
      prompt: 'Before we start, a note about how this works'
    });
  });

  /**
   * A number the payload does not send must not be able to refuse the save.
   *
   * The validator read this field unconditionally while the payload used it
   * only under the override, so an out-of-range value left behind by a trip
   * through "Set it myself" blocked every later save - and the banner sent the
   * author to a READ-ONLY field displaying a perfectly valid estimate, with
   * nothing on screen to correct. Found by the review gate, reproduced, fixed.
   */
  it('does not refuse the save over a length it is no longer sending', async () => {
    const user = userEvent.setup();
    renderForm();
    await fillBasics(user);
    await user.click(screen.getByLabelText(/In Cortex/i));

    await user.click(screen.getByRole('button', { name: /Questions/i }));
    await user.click(screen.getByRole('button', { name: /^Add question$/i }));
    await user.type(
      screen.getByLabelText(/What the participant is asked/i),
      'Which tool slows you down?'
    );

    await user.click(screen.getByRole('button', { name: /Set it myself/i }));
    await user.clear(screen.getByLabelText(/Estimated completion time/i));
    await user.type(screen.getByLabelText(/Estimated completion time/i), '5000');
    await user.click(screen.getByRole('button', { name: /Use the automatic estimate/i }));

    await submitFromLastStep(user, /^Create study$/);
    await waitFor(() => expect(createOpportunity).toHaveBeenCalled());

    const body = vi.mocked(createOpportunity).mock.calls[0][0] as {
      inline_survey?: { estimated_duration_minutes?: number | null };
    };

    expect(body.inline_survey?.estimated_duration_minutes).toBe(2);
    expect(screen.queryByText(/Keep it under 1440 minutes/i)).toBeNull();
  });

  /**
   * "Must be answered" described the participant's obligation from the
   * participant's side, in a control the RESEARCHER uses. Every other product
   * that has this checkbox calls it Required.
   */
  it('calls the answer requirement Required', async () => {
    const user = userEvent.setup();
    renderForm();
    await fillBasics(user);
    await user.click(screen.getByLabelText(/In Cortex/i));

    await user.click(screen.getByRole('button', { name: /Questions/i }));
    await user.click(screen.getByRole('button', { name: /^Add question$/i }));

    expect(screen.getByLabelText('Required')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Must be answered/i)).toBeNull();
  });

  /**
   * A half-written question must not block a save the author has since moved
   * away from. The per-question rules run only while those questions are the
   * thing being authored: ungated, a question abandoned before switching to an
   * external tool refused every later save while naming a field on a tab that
   * is no longer rendered.
   */
  it('does not hold an abandoned question against an external survey', async () => {
    const user = userEvent.setup();
    renderForm();
    await fillBasics(user);
    await user.click(screen.getByLabelText(/In Cortex/i));

    await user.click(screen.getByRole('button', { name: /Questions/i }));
    // Added and left empty, which is what an author does when they change
    // their mind.
    await user.click(screen.getByRole('button', { name: /^Add question$/i }));

    await user.click(screen.getByRole('button', { name: /Basic Information/i }));
    await user.click(screen.getByLabelText(/In an external tool/i));
    await user.click(screen.getByRole('button', { name: /External Link/i }));
    await user.type(
      screen.getByLabelText(/External Link/i),
      'https://example.com/form'
    );

    await submitFromLastStep(user, /^Create study$/);

    await waitFor(() => expect(createOpportunity).toHaveBeenCalled());
  });

  /**
   * The scale is guarded only by min/max on a number input, and the save
   * controls are type="button" so they never run constraint validation - the
   * tab is unmounted anyway while the author is elsewhere. Without a rule the
   * contract refuses the save instead.
   */
  /**
   * An unrelated edit must not resend the delivery mode.
   *
   * The backend gates its publish and linkage checks on the request changing
   * the shape, precisely so a row already in a bad state can still be repaired.
   * Sending this field on every save made both conditions permanently true for
   * polls and surveys - a published poll with no external link could no longer
   * have its title corrected at all, and DELETE was the only way out. The
   * lock-out the backend guard was written to prevent, reintroduced from here.
   */
  it('does not resend the delivery mode on an edit that did not change it', async () => {
    vi.mocked(getOpportunity).mockResolvedValue({
      id: 'opp-1',
      type: 'survey',
      title: 'Developer experience pulse',
      purpose_one_liner: 'Ten short questions about the tools you use every day',
      description_optional: '',
      product_optional: '',
      default_duration_minutes: 30,
      status: 'draft',
      delivery_mode: 'native',
      firsthand_study_id: 'study_questions',
      participant_type_required: 'any',
      sessions: []
    } as never);

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/admin/opportunities/opp-1/edit']}>
        <Routes>
          <Route path="/admin/opportunities/:id/edit" element={<OpportunityForm />} />
        </Routes>
      </MemoryRouter>
    );

    const title = await screen.findByDisplayValue('Developer experience pulse');
    await user.type(title, ' 2026');

    await user.click(screen.getByRole('button', { name: /Save Changes/i }));

    await waitFor(() => expect(updateOpportunity).toHaveBeenCalled());

    const body = vi.mocked(updateOpportunity).mock.calls[0][1] as Record<string, unknown>;
    expect(body).not.toHaveProperty('delivery_mode');
  });

  /**
   * Reached through EDIT mode on purpose: the author fills the Questions tab,
   * leaves it, and saves from somewhere else. The Questions tab is unmounted by
   * then, so nothing on screen can refuse this - only the rule can, and without
   * it the contract refuses the save server-side instead.
   *
   * The same refusal is reachable from the Questions tab itself; that case is
   * covered separately, below.
   */
  it('refuses a rating scale the contract would reject, before sending it', async () => {
    vi.mocked(getOpportunity).mockResolvedValue({
      id: 'opp-1',
      type: 'survey',
      title: 'Developer experience pulse',
      purpose_one_liner: 'Ten short questions about the tools you use every day',
      description_optional: '',
      product_optional: '',
      default_duration_minutes: 30,
      status: 'draft',
      delivery_mode: 'native',
      participant_type_required: 'any',
      sessions: []
    } as never);

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/admin/opportunities/opp-1/edit']}>
        <Routes>
          <Route path="/admin/opportunities/:id/edit" element={<OpportunityForm />} />
        </Routes>
      </MemoryRouter>
    );

    await screen.findByDisplayValue('Developer experience pulse');

    await user.click(screen.getByRole('button', { name: /Questions/i }));
    await user.click(screen.getByRole('button', { name: /^Add question$/i }));
    await user.type(
      screen.getByLabelText(/What the participant is asked/i),
      'Rate it'
    );
    await user.selectOptions(screen.getByLabelText(/^Type$/i), 'rating');
    await user.clear(screen.getByLabelText(/Points on the scale/i));

    await user.click(screen.getByRole('button', { name: /Basic Information/i }));
    await user.click(screen.getByRole('button', { name: /Save Changes/i }));

    expect(updateOpportunity).not.toHaveBeenCalled();
    // On the SPECIFIC message, which only this rule produces. Asserting merely
    // that nothing was sent passed with the rule removed, because the number
    // input's own constraint was blocking the submit instead.
    await screen.findByRole('alert', { name: /There is a problem/i });
    expect(
      inlineErrorText(/Set a scale between 2 and 10 points for question 1/i)
    ).toBeInTheDocument();
  });

  /**
   * Switching back to an external handoff must not leave the questions in the
   * payload: the API refuses them outright for external delivery, which would
   * block the save with an error about a tab the author is no longer looking at.
   */
  it('drops authored questions when the author switches back to an external tool', async () => {
    const user = userEvent.setup();
    renderForm();
    await fillBasics(user);
    await user.click(screen.getByLabelText(/In Cortex/i));

    await user.click(screen.getByRole('button', { name: /Questions/i }));
    await user.click(screen.getByRole('button', { name: /^Add question$/i }));
    await user.type(
      screen.getByLabelText(/What the participant is asked/i),
      'How easy was that?'
    );

    await user.click(screen.getByRole('button', { name: /Basic Information/i }));
    await user.click(screen.getByLabelText(/In an external tool/i));

    await user.click(screen.getByRole('button', { name: /External Link/i }));
    await user.type(
      screen.getByLabelText(/External Link/i),
      'https://example.com/form'
    );

    await submitFromLastStep(user, /^Create study$/);

    await waitFor(() => expect(createOpportunity).toHaveBeenCalled());

    const body = vi.mocked(createOpportunity).mock.calls[0][0] as {
      delivery_mode?: string;
      inline_survey?: unknown;
    };

    expect(body.delivery_mode).toBe('external');
    expect(body.inline_survey).toBeUndefined();
  });
});

/**
 * The first step has nothing to go back to, so its row opens with a spacer
 * rather than a Back control. Rendering one anyway gives the author a button
 * that looks live and does nothing.
 */
describe('starting a survey from an existing set of questions', () => {
  /**
   * The survey twin of the task-list copy tests, written in the same breath as
   * them and deliberately not by reference.
   *
   * The last two steps of this plan each shipped a property that was pinned on
   * one of these two surfaces and silently missing on the other - the identical
   * mutation killed by three tests on the task list and surviving completely
   * here. Everything the task-list tests assert about copying is asserted again
   * below against this surface's own wording, ids and payload key.
   */
  const fillNativeSurvey = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.selectOptions(screen.getByLabelText(/Research Study Type/i), 'survey');
    await user.type(screen.getByLabelText(/^Title/i), 'Developer experience pulse');
    await user.type(
      screen.getByLabelText(/^Purpose/i),
      'Ten short questions about the tools you use every day'
    );
    await user.click(screen.getByLabelText(/In Cortex/i));
    await user.click(screen.getByRole('button', { name: /Questions/i }));
  };

  const SOURCE = {
    study: {
      id: 'study_source',
      title: 'Onboarding pulse',
      intro_text: 'Intro',
      consent_text: 'The wording this researcher actually wrote',
      kind: 'survey' as const,
      status: 'launched' as const,
      estimated_duration_minutes: 14,
      owner_user_id: 'someone-else',
      updated_at: '2026-08-18T00:00:00.000Z'
    },
    steps: [
      { step_id: 'study_source_step_1', order: 1, type: 'open_text', prompt: 'What did you set up first?' },
      {
        step_id: 'study_source_step_2',
        order: 2,
        type: 'multi_choice',
        prompt: 'Which docs did you read?',
        options: ['Getting started', 'API reference', 'Nothing'],
        is_required: true
      },
      {
        step_id: 'study_source_step_3',
        order: 3,
        type: 'rating',
        prompt: 'How clear was it?',
        config: { scale_max: 7 }
      },
      { step_id: 'study_source_step_end', order: 4, type: 'end', prompt: 'Thanks' }
    ],
    can_edit: false
  };

  /**
   * The single most likely way C1 breaks.
   *
   * Both consent textareas used to live inside the third arm of
   * `studyIsReadOnly ? readOnly : showChooser ? picker : editor`, so neither
   * state could reach them. A Consent step lifted out of that arm inherits none
   * of that gating - and would offer an author a consent editor for content
   * they have not chosen yet, pre-filled with a template for a study that does
   * not exist. Whichever study they then pick brings its own wording, silently
   * overwriting whatever they just agreed to.
   */
  it('offers no consent editor while the author is still choosing a source', async () => {
    const user = userEvent.setup();
    vi.mocked(getFirstHandStudies).mockResolvedValue([
      { id: 'study_source', title: 'Onboarding pulse', status: 'launched', kind: 'survey' }
    ] as never);

    renderForm();
    await fillNativeSurvey(user);

    await user.click(
      screen.getByRole('radio', { name: /Start from an existing set of questions/i })
    );
    await user.click(screen.getByRole('button', { name: /^Continue: Screener$/i }));
    await user.click(screen.getByRole('button', { name: /^Continue: Consent$/i }));

    expect(await screen.findByTestId('consent-step')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Consent text/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('consent-locked-text')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Customise consent wording/i })
    ).not.toBeInTheDocument();
  });

  it('shows the copied study its own consent, once one has been chosen', async () => {
    const user = userEvent.setup();
    vi.mocked(getFirstHandStudies).mockResolvedValue([
      { id: 'study_source', title: 'Onboarding pulse', status: 'launched', kind: 'survey' }
    ] as never);
    vi.mocked(getFirstHandStudy).mockResolvedValue(SOURCE as never);

    renderForm();
    await fillNativeSurvey(user);

    await user.click(
      screen.getByRole('radio', { name: /Start from an existing set of questions/i })
    );
    await user.click(
      await screen.findByRole('button', { name: /^Start from this Onboarding pulse$/ })
    );
    await screen.findByText(/Copied from/i);
    await user.click(screen.getByRole('button', { name: /^Continue: Screener$/i }));
    await user.click(screen.getByRole('button', { name: /^Continue: Consent$/i }));

    // The source's wording is nobody's approved wording, and the copy inherits
    // that rather than being re-badged as approved - the failure this whole
    // classification exists to prevent, at the one place it would be invisible.
    expect(await screen.findByTestId('consent-template-state')).toHaveTextContent(
      /Custom wording/i
    );
    expect(screen.getByLabelText(/Consent text/i)).toHaveValue(
      'The wording this researcher actually wrote'
    );
  });

  it('copies a colleague\'s questions into an EDITABLE form, not a read-only one', async () => {
    // The single most likely way this step breaks. `can_edit: false` is a fact
    // about the SOURCE, and edit-mode hydration turns exactly that into a
    // read-only surface. Applying it to a copy would hand the author a form
    // they cannot type in, for content that is about to become theirs.
    const user = userEvent.setup();
    vi.mocked(getFirstHandStudies).mockResolvedValue([
      { id: 'study_source', title: 'Onboarding pulse', status: 'launched', kind: 'survey' }
    ] as never);
    vi.mocked(getFirstHandStudy).mockResolvedValue(SOURCE as never);

    renderForm();
    await fillNativeSurvey(user);

    await user.click(
      screen.getByRole('radio', { name: /Start from an existing set of questions/i })
    );
    await user.click(
      await screen.findByRole('button', { name: /^Start from this Onboarding pulse$/ })
    );
    await screen.findByText(/Copied from/i);

    // Not the read-only surface: no "belongs to another researcher" banner, and
    // no read-only rendering of the content.
    expect(screen.queryByText(/belongs to another researcher/i)).toBeNull();
    expect(screen.queryByTestId('read-only-study-content')).toBeNull();

    // And it is genuinely editable - proved by typing into it, not by the
    // absence of a `disabled` attribute.
    const summaries = await screen.findAllByRole('button', { expanded: false });
    for (const summary of summaries) {
      await user.click(summary);
    }
    const prompts = screen.getAllByLabelText(
      /What the participant is asked/i
    ) as HTMLTextAreaElement[];
    expect(prompts.map((field) => field.value)).toEqual([
      'What did you set up first?',
      'Which docs did you read?',
      'How clear was it?'
    ]);
    await user.clear(prompts[1]);
    await user.type(prompts[1], 'Which docs did you actually open?');

    await submitFromLastStep(user, /^Create study$/);
    await waitFor(() => expect(createOpportunity).toHaveBeenCalled());

    const body = vi.mocked(createOpportunity).mock.calls[0][0] as {
      firsthand_study_id?: string;
      inline_survey?: {
        steps: Record<string, unknown>[];
        consent_text: string;
        estimated_duration_minutes?: number | null;
        copied_from_study_id?: string;
      };
    };

    // Never the id: sending it would relink this opportunity to the colleague's
    // study, which is the behaviour B3 removes.
    expect(body.firsthand_study_id).toBeUndefined();
    // The whole array, in order, with the edit applied to the RIGHT question -
    // a single-item read here could not tell question 2 from question 1.
    expect(body.inline_survey?.steps).toEqual([
      // FRESHLY MINTED, not inherited from the source study. A copied question
      // is a new question: taking the source's identity would leave two studies
      // claiming the same keys, and the copy is about to be stored under a
      // study id of its own anyway.
      { step_key: A_MINTED_IDENTITY, type: 'open_text', prompt: 'What did you set up first?' },
      {
        step_key: A_MINTED_IDENTITY,
        type: 'multi_choice',
        prompt: 'Which docs did you actually open?',
        options: ['Getting started', 'API reference', 'Nothing'],
        is_required: true
      },
      {
        step_key: A_MINTED_IDENTITY,
        type: 'rating',
        prompt: 'How clear was it?',
        config: { scale_max: 7 }
      }
    ]);
    // Three DIFFERENT identities. `expect.stringMatching` is satisfied by three
    // copies of one value, and three questions sharing an identity would store
    // as a single row - a copied survey silently two questions shorter.
    expect(
      new Set(body.inline_survey?.steps.map((step) => step.step_key)).size
    ).toBe(3);
    expect(body.inline_survey?.consent_text).toBe(
      'The wording this researcher actually wrote'
    );
    // Carried, not re-derived. The automatic estimate for three questions is
    // not 14, so a re-derivation would be visible.
    expect(body.inline_survey?.estimated_duration_minutes).toBe(14);
    expect(body.inline_survey?.copied_from_study_id).toBe('study_source');
  });

  it('refuses to copy a recorded task list through the questions surface', async () => {
    // The kind filter keeps this out of the list; this is the second line of
    // defence, and it must refuse rather than half-copy - a recorded study's
    // steps would hydrate into a vocabulary that cannot hold them.
    const user = userEvent.setup();
    vi.mocked(getFirstHandStudies).mockResolvedValue([
      { id: 'study_recorded', title: 'Checkout walkthrough', status: 'launched', kind: 'survey' }
    ] as never);
    vi.mocked(getFirstHandStudy).mockResolvedValue({
      ...SOURCE,
      study: { ...SOURCE.study, id: 'study_recorded', kind: 'recorded' }
    } as never);

    renderForm();
    await fillNativeSurvey(user);

    await user.click(
      screen.getByRole('radio', { name: /Start from an existing set of questions/i })
    );
    await user.click(
      await screen.findByRole('button', { name: /^Start from this Checkout walkthrough$/ })
    );

    expect(
      await screen.findByText(/recorded task list, not a set of questions/i)
    ).toBeInTheDocument();
    // Nothing was copied: no provenance, and no questions in the editor.
    expect(screen.queryByText(/Copied from/i)).toBeNull();
    expect(screen.queryByLabelText(/What the participant is asked/i)).toBeNull();
  });

  it('refuses to copy questions this form cannot round-trip, and hydrates nothing', async () => {
    // The survey analogue of the recorded twin's divergent-URL case: an NPS
    // question is fixed at 0-10 and never carries a config, so a STORED one
    // that somehow does (written elsewhere) would silently lose it on the
    // next save - `toSurveyPayloadStep` only keeps config for rating and
    // multi_choice.
    const user = userEvent.setup();
    vi.mocked(getFirstHandStudies).mockResolvedValue([
      { id: 'study_source', title: 'Onboarding pulse', status: 'launched', kind: 'survey' }
    ] as never);
    vi.mocked(getFirstHandStudy).mockResolvedValue({
      ...SOURCE,
      steps: [
        {
          step_id: 'study_source_step_1',
          order: 1,
          type: 'nps',
          prompt: 'Would you recommend us?',
          config: { scale_max: 7 }
        },
        { step_id: 'study_source_step_end', order: 2, type: 'end', prompt: 'Thanks' }
      ]
    } as never);

    renderForm();
    await fillNativeSurvey(user);

    await user.click(
      screen.getByRole('radio', { name: /Start from an existing set of questions/i })
    );
    await user.click(
      await screen.findByRole('button', { name: /^Start from this Onboarding pulse$/ })
    );

    expect(
      await screen.findByText(
        /use something this form cannot show, so copying them here would drop part of them/i
      )
    ).toBeInTheDocument();
    // Nothing was hydrated: no provenance note, and the chooser is still on
    // screen rather than the editor.
    expect(screen.queryByText(/Copied from/i)).toBeNull();
    expect(screen.getByTestId('survey-source-list')).toBeInTheDocument();
    expect(screen.queryByLabelText(/What the participant is asked/i)).toBeNull();
  });

  it('offers only survey-shaped sets in the questions chooser', async () => {
    // Named for what this test actually exercises. It used to claim the
    // recorded twin's half of the rule too, in its own title, and asserted
    // nothing about it - the task-list chooser has its own test, in
    // OpportunityForm.test.tsx, against the task-list surface itself.
    const user = userEvent.setup();
    vi.mocked(getFirstHandStudies).mockResolvedValue([
      { id: 'study_survey', title: 'A survey set', status: 'launched', kind: 'survey' },
      { id: 'study_recorded', title: 'A recorded list', status: 'launched', kind: 'recorded' }
    ] as never);

    renderForm();
    await fillNativeSurvey(user);
    await user.click(
      screen.getByRole('radio', { name: /Start from an existing set of questions/i })
    );

    // Queried by role: the title also appears, visually hidden, inside both
    // row buttons' accessible names, so a bare text match is ambiguous.
    expect(
      await screen.findByRole('button', { name: /^Start from this A survey set$/ })
    ).toBeInTheDocument();
    expect(screen.queryByText('A recorded list')).toBeNull();
  });

  it('offers Save Changes as soon as a copy is taken in edit mode, before anything else changes', async () => {
    // The survey twin of the task-list `hasChanges()` test: `study_source` and
    // `copied_from_study_id` are compared against the baseline
    // `loadOpportunity` seeded, both 'blank'/'' for a draft with no study yet.
    // Read on Basic Information, because the Questions step is the one step
    // whose action row carries no Save Changes shortcut.
    vi.mocked(getOpportunity).mockResolvedValue({
      id: 'opp-1',
      type: 'survey',
      title: 'Draft saved early',
      purpose_one_liner: 'Saved before the questions were written, which is allowed',
      description_optional: '',
      product_optional: '',
      default_duration_minutes: 30,
      status: 'draft',
      delivery_mode: 'native',
      firsthand_study_id: null,
      participant_type_required: 'any',
      sessions: []
    } as never);
    vi.mocked(getFirstHandStudies).mockResolvedValue([
      { id: 'study_source', title: 'Onboarding pulse', status: 'launched', kind: 'survey' }
    ] as never);
    vi.mocked(getFirstHandStudy).mockResolvedValue(SOURCE as never);

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/admin/opportunities/opp-1/edit']}>
        <Routes>
          <Route path="/admin/opportunities/:id/edit" element={<OpportunityForm />} />
        </Routes>
      </MemoryRouter>
    );

    await screen.findByDisplayValue('Draft saved early');
    await user.click(screen.getByRole('button', { name: /Questions/i }));
    expect(
      await screen.findByRole('radio', { name: /Create questions for this study/i })
    ).toBeChecked();

    await user.click(
      screen.getByRole('radio', { name: /Start from an existing set of questions/i })
    );
    await user.click(
      await screen.findByRole('button', { name: /^Start from this Onboarding pulse$/ })
    );
    await screen.findByText(/Copied from/i);

    await user.click(screen.getByRole('button', { name: /Basic Information/i }));
    expect(await screen.findByRole('button', { name: /Save Changes/i })).toBeInTheDocument();
  });

  it('does not fetch the sets until the author asks to start from one', async () => {
    const user = userEvent.setup();
    renderForm();
    await fillNativeSurvey(user);

    expect(
      screen.getByRole('radio', { name: /Create questions for this study/i })
    ).toBeChecked();
    expect(vi.mocked(getFirstHandStudies)).not.toHaveBeenCalled();
  });

  describe('choosing a different set of questions after one is already copied in', () => {
    beforeEach(() => {
      vi.mocked(getFirstHandStudies).mockResolvedValue([
        { id: 'study_source', title: 'Onboarding pulse', status: 'launched', kind: 'survey' }
      ] as never);
    });

    it('reopens the chooser without losing the content already copied in', async () => {
      const user = userEvent.setup();
      vi.mocked(getFirstHandStudy).mockResolvedValue(SOURCE as never);
      renderForm();
      await fillNativeSurvey(user);

      await user.click(
        screen.getByRole('radio', { name: /Start from an existing set of questions/i })
      );
      await user.click(
        await screen.findByRole('button', { name: /^Start from this Onboarding pulse$/ })
      );
      await screen.findByText(/Copied from/i);

      await user.click(
        screen.getByRole('button', { name: /Choose a different set of questions/i })
      );

      expect(await screen.findByTestId('survey-source-list')).toBeInTheDocument();
      expect(screen.getByText(/Copied from/i)).toBeInTheDocument();

      await user.click(
        screen.getByRole('button', { name: /Keep the set of questions already copied in/i })
      );
      expect(screen.queryByTestId('survey-source-list')).not.toBeInTheDocument();
      expect(screen.getByText(/Copied from/i)).toBeInTheDocument();
    });

    it('leaves the chooser open when a reopened choice is refused', async () => {
      const user = userEvent.setup();
      vi.mocked(getFirstHandStudy)
        .mockResolvedValueOnce(SOURCE as never)
        .mockResolvedValueOnce({
          ...SOURCE,
          steps: [
            {
              step_id: 'study_source_step_1',
              order: 1,
              type: 'nps',
              prompt: 'Would you recommend us?',
              config: { scale_max: 7 }
            },
            { step_id: 'study_source_step_end', order: 2, type: 'end', prompt: 'Thanks' }
          ]
        } as never);
      renderForm();
      await fillNativeSurvey(user);

      await user.click(
        screen.getByRole('radio', { name: /Start from an existing set of questions/i })
      );
      await user.click(
        await screen.findByRole('button', { name: /^Start from this Onboarding pulse$/ })
      );
      await screen.findByText(/Copied from/i);

      await user.click(
        screen.getByRole('button', { name: /Choose a different set of questions/i })
      );
      await user.click(
        await screen.findByRole('button', { name: /^Start from this Onboarding pulse$/ })
      );

      expect(
        await screen.findByText(
          /use something this form cannot show, so copying them here would drop part of them/i
        )
      ).toBeInTheDocument();
      expect(screen.getByTestId('survey-source-list')).toBeInTheDocument();
    });
  });

  it('refuses when the source cannot even be loaded, naming the reason', async () => {
    const user = userEvent.setup();
    vi.mocked(getFirstHandStudies).mockResolvedValue([
      { id: 'study_source', title: 'Onboarding pulse', status: 'launched', kind: 'survey' }
    ] as never);
    vi.mocked(getFirstHandStudy).mockRejectedValueOnce(new Error('network down'));
    renderForm();
    await fillNativeSurvey(user);

    await user.click(
      screen.getByRole('radio', { name: /Start from an existing set of questions/i })
    );
    await user.click(
      await screen.findByRole('button', { name: /^Start from this Onboarding pulse$/ })
    );

    expect(
      await screen.findByText(/those questions could not be loaded, so nothing was copied/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/Copied from/i)).toBeNull();
  });

  it('does not offer a draft set of questions as a copy source', async () => {
    const user = userEvent.setup();
    vi.mocked(getFirstHandStudies).mockResolvedValue([
      { id: 'study_source', title: 'Onboarding pulse', status: 'launched', kind: 'survey' },
      { id: 'study_draft', title: 'Unfinished draft set', status: 'draft', kind: 'survey' }
    ] as never);
    renderForm();
    await fillNativeSurvey(user);

    await user.click(
      screen.getByRole('radio', { name: /Start from an existing set of questions/i })
    );

    expect(
      await screen.findByRole('button', { name: /^Start from this Onboarding pulse$/ })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^Start from this Unfinished draft set$/ })
    ).not.toBeInTheDocument();
  });

  it('shows the copy-mode publish message where the chooser actually is', async () => {
    const user = userEvent.setup();
    renderForm();
    await fillNativeSurvey(user);

    await user.click(
      screen.getByRole('radio', { name: /Start from an existing set of questions/i })
    );
    await walkToReview(user);
    await setStatus(user, 'published');
    // Scoped to the step strip: Review's own summary now also renders an
    // "Edit Questions" button, which `/Questions/i` also matches unscoped.
    await user.click(
      within(screen.getByRole('navigation', { name: 'Form steps' })).getByRole('button', {
        name: /Questions/i
      })
    );

    await submitFromLastStep(user, /^Create study$/);

    await screen.findByRole('alert', { name: /There is a problem/i });
    const message = inlineErrorText(
      /Choose a set of questions to start from, or switch to writing them here/i
    );
    expect(message).toBeVisible();
    expect(screen.getByTestId('survey-source-list')).toBeInTheDocument();
  });

  it('clears a stale questions validation error once a copy is taken', async () => {
    const user = userEvent.setup();
    vi.mocked(getFirstHandStudies).mockResolvedValue([
      { id: 'study_source', title: 'Onboarding pulse', status: 'launched', kind: 'survey' }
    ] as never);
    vi.mocked(getFirstHandStudy).mockResolvedValue(SOURCE as never);
    renderForm();
    await fillNativeSurvey(user);

    await walkToReview(user);
    await setStatus(user, 'published');
    // Scoped to the step strip: Review's own summary now also renders an
    // "Edit Questions" button, which `/Questions/i` also matches unscoped.
    await user.click(
      within(screen.getByRole('navigation', { name: 'Form steps' })).getByRole('button', {
        name: /Questions/i
      })
    );
    await submitFromLastStep(user, /^Create study$/);
    await screen.findByRole('alert', { name: /There is a problem/i });
    expect(
      inlineErrorText(/Add at least one question before publishing/i)
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole('radio', { name: /Start from an existing set of questions/i })
    );
    await user.click(
      await screen.findByRole('button', { name: /^Start from this Onboarding pulse$/ })
    );
    await screen.findByText(/Copied from/i);

    // Gone from BOTH places. Checking only the inline copy would pass while the
    // summary went on naming a problem the author has just fixed.
    expect(
      screen.queryAllByText(/Add at least one question before publishing/i)
    ).toEqual([]);
  });
});

describe('the step action row', () => {
  it('offers no backward control on the first step', async () => {
    renderForm();

    // Anchors this test to step 1: without confirming we are standing on the
    // step whose forward control reads "Continue: Content & Details", the
    // negative assertion below would pass on any step at all.
    await screen.findByRole('button', { name: /Continue: Content & Details/i });

    // Matched on the prefix, not on the whole label: the control names the
    // step it returns to now, so pinning the old bare "Back" here would be an
    // assertion that can never fail again.
    expect(screen.queryByRole('button', { name: /^Previous: /i })).not.toBeInTheDocument();
  });
});

/**
 * The Questions tab was the only step whose forward control was a real
 * `type="submit"`. Every other step uses `type="button"` and calls
 * `handleSubmit` directly, so the form has two different submit mechanics
 * depending on which step the author happens to be on.
 *
 * Two things follow from that, and both are author-visible:
 *
 *  - a submit button makes Enter in any text field submit the form, so typing
 *    a question and pressing Enter created or updated the opportunity
 *  - a submit button runs the browser's own constraint validation first, so the
 *    rating scale's `min`/`max` blocked the save with a native tooltip and the
 *    form's own refusal never ran - on the very tab holding the offending field
 */
describe('the forward control on the Questions tab', () => {
  const openQuestionsTab = async (user: ReturnType<typeof userEvent.setup>) => {
    render(
      <MemoryRouter initialEntries={['/admin/opportunities/opp-1/edit']}>
        <Routes>
          <Route path="/admin/opportunities/:id/edit" element={<OpportunityForm />} />
        </Routes>
      </MemoryRouter>
    );

    await screen.findByDisplayValue('Developer experience pulse');
    await user.click(screen.getByRole('button', { name: /Questions/i }));
  };

  const editedSurvey = {
    id: 'opp-1',
    type: 'survey',
    title: 'Developer experience pulse',
    purpose_one_liner: 'Ten short questions about the tools you use every day',
    description_optional: '',
    product_optional: '',
    default_duration_minutes: 30,
    status: 'draft',
    delivery_mode: 'native',
    participant_type_required: 'any',
    sessions: []
  };

  /**
   * The SURVEY twin of the unclassified-hydration assertion made on the
   * recorded path. An independent mutation pass found this fallback - and both
   * version fallbacks - uncovered: a survey study with a NULL classification
   * hydrated as `survey-default` version 1 and was shown to the author under a
   * green approved badge.
   */
  it('reads an unclassified survey as custom, not as approved', async () => {
    // The linked study is what carries the classification, so the fixture has
    // to have one - without it the form keeps its create-mode defaults and the
    // hydration this test is about never runs.
    vi.mocked(getOpportunity).mockResolvedValue(
      { ...editedSurvey, firsthand_study_id: 'study_questions' } as never
    );
    vi.mocked(getFirstHandStudy).mockResolvedValue({
      study: {
        id: 'study_questions',
        title: 'Developer experience pulse',
        intro_text: 'Intro',
        consent_text: 'Answers are stored for research analysis',
        kind: 'survey',
        status: 'launched',
        estimated_duration_minutes: null,
        owner_user_id: 'u1',
        consent_template_id: null,
        consent_template_version: null,
        updated_at: '2026-08-19T00:00:00.000Z'
      },
      steps: [
        { step_id: 'study_questions_step_1', order: 1, type: 'open_text', prompt: 'Which tool slows you down?' },
        { step_id: 'study_questions_step_end', order: 2, type: 'end', prompt: 'Thanks' }
      ],
      can_edit: true
    } as never);

    const user = userEvent.setup();
    await openQuestionsTab(user);
    await user.click(screen.getByRole('button', { name: /^Continue: Screener$/i }));
    await user.click(screen.getByRole('button', { name: /^Continue: Consent$/i }));

    expect(await screen.findByTestId('consent-template-state')).toHaveTextContent(
      /Custom wording/i
    );
  });

  /**
   * The SURVEY twin of the classification-only save. A save that changes
   * nothing but the classification has to be offerable on both authoring
   * paths - `hasChanges` carries a separate clause pair for each, and a clause
   * pinned on one twin and not the other is this project's most repeated defect.
   */
  it('offers a save when only the survey classification changed', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(
      { ...editedSurvey, firsthand_study_id: 'study_questions' } as never
    );
    vi.mocked(getFirstHandStudy).mockResolvedValue({
      study: {
        id: 'study_questions',
        title: 'Developer experience pulse',
        intro_text: 'Intro',
        consent_text: SURVEY_CONSENT_TEMPLATE.text,
        kind: 'survey',
        status: 'launched',
        estimated_duration_minutes: null,
        owner_user_id: 'u1',
        consent_template_id: 'custom',
        consent_template_version: null,
        updated_at: '2026-08-19T00:00:00.000Z'
      },
      steps: [
        { step_id: 'study_questions_step_1', order: 1, type: 'open_text', prompt: 'Which tool slows you down?' },
        { step_id: 'study_questions_step_end', order: 2, type: 'end', prompt: 'Thanks' }
      ],
      can_edit: true
    } as never);

    const user = userEvent.setup();
    await openQuestionsTab(user);
    await user.click(screen.getByRole('button', { name: /^Continue: Screener$/i }));
    await user.click(screen.getByRole('button', { name: /^Continue: Consent$/i }));

    expect(screen.queryByRole('button', { name: /Save Changes/i })).toBeNull();

    // Away and back: setting a field to the value it already holds fires no
    // change event, so the round trip is what moves the classification while
    // leaving the wording exactly as it was found.
    const field = () => screen.getByLabelText(/Consent text/i) as HTMLTextAreaElement;
    fireEvent.change(field(), { target: { value: 'something else' } });
    fireEvent.change(field(), { target: { value: SURVEY_CONSENT_TEMPLATE.text } });

    expect(field().value).toBe(SURVEY_CONSENT_TEMPLATE.text);
    expect(screen.getByTestId('consent-template-state')).toHaveTextContent(
      'Standard survey consent (version 1)'
    );
    expect(
      await screen.findByRole('button', { name: /Save Changes/i })
    ).toBeInTheDocument();
  });

  /** The survey twin of the per-kind field-wiring assertion. */
  it('gives the consent field the survey key, not the recorded one', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(
      { ...editedSurvey, firsthand_study_id: 'study_questions' } as never
    );

    const user = userEvent.setup();
    await openQuestionsTab(user);
    await user.click(screen.getByRole('button', { name: /^Continue: Screener$/i }));
    await user.click(screen.getByRole('button', { name: /^Continue: Consent$/i }));

    const unlock = screen.queryByRole('button', { name: /Customise consent wording/i });
    if (unlock) await user.click(unlock);

    expect(await screen.findByLabelText(/Consent text/i)).toHaveAttribute(
      'id',
      'inline_survey_consent_text'
    );
  });

  /**
   * And the step names the surface it sends the author back to, per kind. A
   * swapped `contentStepTitle` sends a survey author to "Task List", which is
   * not a step their opportunity has.
   */
  it('names Questions, not Task List, when sending a survey author back', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(
      { ...editedSurvey, firsthand_study_id: null } as never
    );
    vi.mocked(getFirstHandStudies).mockResolvedValue([] as never);

    const user = userEvent.setup();
    await openQuestionsTab(user);
    await user.click(
      await screen.findByRole('radio', { name: /Start from an existing set of questions/i })
    );
    await user.click(screen.getByRole('button', { name: /^Continue: Screener$/i }));
    await user.click(screen.getByRole('button', { name: /^Continue: Consent$/i }));

    const back = await screen.findByRole('button', { name: /Go back to Questions/i });
    await user.click(back);

    // And the click lands on the content step, not somewhere else.
    expect(await screen.findByRole('radio', { name: /Start from an existing set of questions/i })).toBeInTheDocument();
  });

  /**
   * Asserted on the whole form rather than on one button, because the property
   * that matters is that NOTHING in it can be submitted implicitly. A `button`
   * with no `type` attribute defaults to submit, so it counts too.
   */
  it('leaves the form with no control that can submit it implicitly', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(editedSurvey as never);

    const user = userEvent.setup();
    await openQuestionsTab(user);

    const expectNoImplicitSubmit = () => {
      const form = document.querySelector('form');
      expect(form).not.toBeNull();
      expect(
        form!.querySelectorAll(
          'button[type="submit"], input[type="submit"], button:not([type])'
        )
      ).toHaveLength(0);
    };

    // Checked on all FOUR steps that lead to the terminal control, because
    // C1 moved the terminal control onto Consent, C3 moved it again onto
    // Review, and MR2 inserted a Screener step between Questions and Consent.
    // Checking only where the control now lives would let a step it left behind
    // reacquire one - and checking only a step it left behind would test
    // nothing at all, which is precisely what this test did the moment
    // Consent was added.
    await screen.findByRole('button', { name: /^Continue: Screener$/i });
    expectNoImplicitSubmit();

    await user.click(screen.getByRole('button', { name: /^Continue: Screener$/i }));
    await screen.findByRole('button', { name: /^Continue: Consent$/i });
    expectNoImplicitSubmit();

    await user.click(screen.getByRole('button', { name: /^Continue: Consent$/i }));
    await screen.findByRole('button', { name: /^Continue: Review$/i });
    expectNoImplicitSubmit();

    await user.click(screen.getByRole('button', { name: /^Continue: Review$/i }));
    await screen.findByRole('button', { name: /^Save changes$/ });
    expectNoImplicitSubmit();
  });

  /**
   * The duration input carries `min={1}`, and until the forward control became
   * a plain button the browser enforced it on this tab and only this tab. That
   * enforcement is gone deliberately, so the rule has to exist in the form -
   * otherwise a negative length reaches the API, which refuses it as
   * `estimated_duration_minutes` without naming the field the author typed in.
   */
  it('refuses a negative length, naming the field rather than letting the API do it', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(editedSurvey as never);

    const user = userEvent.setup();
    await openQuestionsTab(user);

    await user.click(screen.getByRole('button', { name: /^Add question$/i }));
    await user.type(
      screen.getByLabelText(/What the participant is asked/i),
      'Which tool slows you down?'
    );
    // Taken over from the automatic estimate first: the field is read-only
    // while the estimate is in force, so there is no way to type a negative
    // length into it until the author has explicitly asked to set it.
    await user.click(screen.getByRole('button', { name: /Set it myself/i }));
    await user.clear(screen.getByLabelText(/Estimated completion time/i));
    await user.type(screen.getByLabelText(/Estimated completion time/i), '-3');

    await submitFromLastStep(user, /^Save changes$/);

    expect(updateOpportunity).not.toHaveBeenCalled();
    await screen.findByRole('alert', { name: /There is a problem/i });
    expect(
      inlineErrorText(/at least 1 minute, or leave it empty/i)
    ).toBeInTheDocument();
  });

  /**
   * The same refusal the existing rating test reaches by leaving the tab. It
   * has to be reachable from the tab the author is actually on, which is where
   * the native tooltip used to fire instead.
   */
  it('refuses a rating scale from the Questions tab itself, naming the rule', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(editedSurvey as never);

    const user = userEvent.setup();
    await openQuestionsTab(user);

    await user.click(screen.getByRole('button', { name: /^Add question$/i }));
    await user.type(
      screen.getByLabelText(/What the participant is asked/i),
      'Rate it'
    );
    await user.selectOptions(screen.getByLabelText(/^Type$/i), 'rating');
    await user.clear(screen.getByLabelText(/Points on the scale/i));

    await submitFromLastStep(user, /^Save changes$/);

    expect(updateOpportunity).not.toHaveBeenCalled();
    await screen.findByRole('alert', { name: /There is a problem/i });
    expect(
      inlineErrorText(/Set a scale between 2 and 10 points for question 1/i)
    ).toBeInTheDocument();
  });
});
