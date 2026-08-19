import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityForm, {
  clearTypeConditionalErrors,
  describeValidationFailure,
  FIELD_LOCATIONS,
  locateField,
  UNMODERATED_EXTERNAL_PARTICIPANT_ERROR,
} from '../OpportunityForm';
import { createOpportunity, getFirstHandStudies, getOpportunity, updateOpportunity } from '../../api/client';
import { getFirstHandStudy } from '../../api/firsthand-studies';

// OpportunityForm is an admin-gated, context-heavy page. Model a signed-in
// researcher_admin so the auth gate lets the form render, and keep the theme
// light so the WebGL background (rendered only when isDark) never mounts under jsdom.
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'admin-1', role: 'researcher_admin', name: 'Admin' },
    loading: false,
  }),
}));

vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'light' }),
}));

// Heavy leaf components irrelevant to the A1 study-vs-external-link behaviour;
// stub them so jsdom never pulls in three.js or the session manager.
vi.mock('../../components/SlowNeuralBackground', () => ({ default: () => null }));
vi.mock('../../components/AdminSessionManager', () => ({ default: () => null }));

// The form and the Task List tab both call the API client on interaction.
// Stub every function they use; getFirstHandStudies returns one launched study
// so the picker has something to render. (Mocks are defined inside the factory
// to avoid the vi.mock hoisting temporal-dead-zone trap.)
vi.mock('../../api/client', () => ({
  createOpportunity: vi.fn(),
  updateOpportunity: vi.fn(),
  getOpportunity: vi.fn(),
  getSessions: vi.fn().mockResolvedValue([]),
  getFirstHandStudies: vi.fn().mockResolvedValue([
    { id: 'study_demo', title: 'Demo Study', status: 'launched' },
  ]),
}));

// The single-study getter the form calls in edit mode to read back what the
// author wrote. A separate module from the client, so it needs its own factory -
// and every export this file's subject touches has to be in it, or the form
// calls `undefined(...)` and the failure reads as a bug in the form.
//
// Rejecting by default is deliberate: a test that puts a linked study on an
// opportunity without saying what that study CONTAINS is not describing a real
// state, and the form's load-failure path (which refuses to save) is the honest
// answer to it. Tests that mean a real study queue a resolved value.
vi.mock('../../api/firsthand-studies', () => ({
  getFirstHandStudy: vi.fn().mockRejectedValue(new Error('not stubbed')),
}));

/**
 * A linked study as the API returns it: the record, its steps with the
 * appended `end` marker, and whether this reader may edit it.
 */
const linkedStudy = (
  overrides: {
    kind?: 'recorded' | 'survey';
    steps?: Array<Record<string, unknown>>;
    consent_text?: string;
    estimated_duration_minutes?: number | null;
    updated_at?: string;
    can_edit?: boolean;
  } = {}
) => {
  const steps = overrides.steps ?? [
    { step_id: 'study_demo_step_1', order: 1, type: 'open_text', prompt: 'What did you try first?' },
  ];

  return {
    study: {
      id: 'study_demo',
      title: 'Demo Study',
      intro_text: 'Intro',
      consent_text: overrides.consent_text ?? 'Bespoke consent the author wrote',
      kind: overrides.kind ?? 'recorded',
      status: 'launched' as const,
      estimated_duration_minutes:
        overrides.estimated_duration_minutes === undefined
          ? 12
          : overrides.estimated_duration_minutes,
      owner_user_id: 'admin-1',
      updated_at: overrides.updated_at ?? '2026-08-19T00:00:00.000Z',
    },
    steps: [
      ...steps,
      { step_id: 'study_demo_step_end', order: steps.length + 1, type: 'end', prompt: 'Thanks' },
    ],
    can_edit: overrides.can_edit ?? true,
  } as never;
};

// clearAllMocks resets call history but keeps mockResolvedValue implementations,
// so getFirstHandStudies still resolves its launched study in every test.
beforeEach(() => {
  vi.clearAllMocks();
  // jsdom has no scroll implementation, and every refused action in this form
  // now scrolls the banner into view - without this the suite is buried in
  // "Not implemented: window.scrollTo". Re-established each test, after the
  // clear, so call history is per-test.
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

// ---------------------------------------------------------------------------
// Pure logic - the two behaviours this change actually introduces (A1 follow-up)
// ---------------------------------------------------------------------------

describe('clearTypeConditionalErrors', () => {
  it('drops external-link and participant-type errors, keeps the study error, when switching to unmoderated', () => {
    const cleared = clearTypeConditionalErrors(
      {
        external_link_optional: 'x',
        participant_type_required: 'y',
        firsthand_study_id: 'keep',
        title: 'keep',
      },
      'unmoderated'
    );
    expect(cleared).toEqual({ firsthand_study_id: 'keep', title: 'keep' });
  });

  it('drops the stale firsthand-study error (and M2 error) when switching away from unmoderated', () => {
    const cleared = clearTypeConditionalErrors(
      {
        firsthand_study_id: 'x',
        participant_type_required: 'y',
        external_link_optional: 'keep',
        title: 'keep',
      },
      'poll'
    );
    expect(cleared).toEqual({ external_link_optional: 'keep', title: 'keep' });
  });

  it('drops both external-link and study errors for session types (test/interview)', () => {
    const cleared = clearTypeConditionalErrors(
      { external_link_optional: 'x', firsthand_study_id: 'y', title: 'keep' },
      'test'
    );
    expect(cleared).toEqual({ title: 'keep' });
  });

  it('does not mutate the input errors object', () => {
    const input = { external_link_optional: 'x', firsthand_study_id: 'y' };
    clearTypeConditionalErrors(input, 'unmoderated');
    expect(input).toEqual({ external_link_optional: 'x', firsthand_study_id: 'y' });
  });
});

describe('UNMODERATED_EXTERNAL_PARTICIPANT_ERROR', () => {
  it('matches the authoritative backend wording exactly', () => {
    expect(UNMODERATED_EXTERNAL_PARTICIPANT_ERROR).toBe(
      'Unmoderated studies cannot use an external participant type; participants must be logged-in Cortex users'
    );
  });
});

// ---------------------------------------------------------------------------
// Rendered behaviour - unmoderated routes to the FirstHand study, not a link (A1)
// ---------------------------------------------------------------------------

const renderForm = () =>
  render(
    <MemoryRouter>
      <OpportunityForm />
    </MemoryRouter>
  );

const selectType = (value: string) => {
  fireEvent.change(screen.getByRole('combobox', { name: /Research Study Type/i }), {
    target: { value },
  });
};

describe('OpportunityForm - unmoderated is FirstHand-only (A1)', () => {
  it('renders the create form for an admin without loading an opportunity', () => {
    renderForm();
    expect(
      screen.getByRole('combobox', { name: /Research Study Type/i })
    ).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /Status/i })).toBeInTheDocument();
    // Create mode makes no fetch for an existing opportunity.
    expect(vi.mocked(getOpportunity)).not.toHaveBeenCalled();
  });

  it('routes unmoderated opportunities to the Task List tab, not External Link', () => {
    renderForm();
    selectType('unmoderated');

    // The FirstHand Study step replaces the External Link step for this type.
    expect(
      screen.getByRole('button', { name: /Task List/i })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /External Link/i })
    ).not.toBeInTheDocument();
    // ...and the type helper copy no longer names an internal product.
    expect(
      screen.getByText('Self-guided recorded study')
    ).toBeInTheDocument();
  });

  it('keeps the External Link tab for poll and hides the Task List tab', () => {
    renderForm();
    selectType('poll');

    expect(
      screen.getByRole('button', { name: /External Link/i })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Task List/i })
    ).not.toBeInTheDocument();
  });

  it('lets an unmoderated study be authored inline without visiting the Task Lists area', async () => {
    renderForm();
    selectType('unmoderated');

    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));

    // Authoring is the default path, so the tab opens on the task author and
    // does not fetch the study list at all.
    fireEvent.click(await screen.findByRole('button', { name: 'Add task' }));

    expect(
      screen.getByLabelText(/What the participant sees/i)
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Consent text/i)).toBeInTheDocument();
    expect(vi.mocked(getFirstHandStudies)).not.toHaveBeenCalled();
  });

  // Duration used to be taken from `default_duration_minutes`, the OPPORTUNITY's
  // field - which unmoderated never shows, so it sat at its default and every
  // recorded study told participants a length nobody had chosen, above a consent
  // button. These two pin the payload: it comes from the study's own field, and
  // an untouched field sends nothing at all.
  // Typed rather than `as any`: this file's per-file suppression budget for
  // no-explicit-any is full, and one more would fail the repo lint.
  type SubmittedPayload = {
    default_duration_minutes?: number;
    inline_study?: { estimated_duration_minutes?: number };
  };
  const submittedPayload = (): SubmittedPayload =>
    vi.mocked(createOpportunity).mock.calls[0][0] as unknown as SubmittedPayload;

  const fillMinimalStudy = async () => {
    fireEvent.change(screen.getByLabelText(/^Title/i), {
      target: { value: 'Checkout flow walkthrough' }
    });
    fireEvent.change(screen.getByLabelText(/purpose/i), {
      target: { value: 'Find out where people stall in the checkout flow' }
    });
    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add task' }));
    fireEvent.change(screen.getByLabelText(/What the participant sees/i), {
      target: { value: 'Find the export button' }
    });
  };

  it('sends the duration the researcher typed, not the opportunity default', async () => {
    renderForm();
    selectType('unmoderated');
    await fillMinimalStudy();

    fireEvent.change(screen.getByLabelText(/how long it takes/i), {
      target: { value: '18' }
    });
    fireEvent.click(screen.getByRole('button', { name: /^Create/i }));

    await vi.waitFor(() => {
      expect(vi.mocked(createOpportunity)).toHaveBeenCalled();
    });

    const payload = submittedPayload();
    expect(payload.inline_study?.estimated_duration_minutes).toBe(18);
    // 30 is the column default that used to be sent for every recorded study.
    expect(payload.inline_study?.estimated_duration_minutes).not.toBe(
      payload.default_duration_minutes
    );
  });

  it('sends no duration at all when the field is left empty', async () => {
    renderForm();
    selectType('unmoderated');
    await fillMinimalStudy();

    fireEvent.click(screen.getByRole('button', { name: /^Create/i }));

    await vi.waitFor(() => {
      expect(vi.mocked(createOpportunity)).toHaveBeenCalled();
    });

    expect(submittedPayload().inline_study?.estimated_duration_minutes).toBeUndefined();
  });

  it('authors every task as a spoken-answer instruction - no response type to pick', async () => {
    renderForm();
    selectType('unmoderated');

    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add task' }));

    // Sessions record screen and voice, so participants answer out loud.
    // Offering typed-response types invited them to stop talking and type;
    // there is deliberately no type selector any more.
    expect(
      screen.queryByRole('combobox', { name: /^Type$/i })
    ).toBeNull();
  });

  it('sends the starting url, and blocks one that could run against the session', async () => {
    renderForm();
    selectType('unmoderated');

    fireEvent.change(screen.getByLabelText(/^Title/i), {
      target: { value: 'Checkout flow walkthrough' }
    });
    fireEvent.change(screen.getByLabelText(/purpose/i), {
      target: { value: 'Find out where people stall in the checkout flow' }
    });

    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add task' }));
    fireEvent.change(screen.getByLabelText(/What the participant sees/i), {
      target: { value: 'Find the export button' }
    });

    // An active-scheme URL is refused before it can reach the payload.
    fireEvent.change(screen.getByLabelText(/Starting URL/i), {
      target: { value: 'javascript:alert(1)' }
    });
    fireEvent.click(screen.getByRole('button', { name: /^Create/i }));

    expect(
      await screen.findByText(/http\(s\) address, or a path beginning with a single/i)
    ).toBeInTheDocument();
    expect(vi.mocked(createOpportunity)).not.toHaveBeenCalled();

    // A real one goes through and lands on the payload.
    fireEvent.change(screen.getByLabelText(/Starting URL/i), {
      target: { value: 'https://example.com/checkout' }
    });
    fireEvent.click(screen.getByRole('button', { name: /^Create/i }));

    await vi.waitFor(() => {
      expect(vi.mocked(createOpportunity)).toHaveBeenCalled();
    });

    const payload = vi.mocked(createOpportunity).mock.calls[0][0] as any;
    expect(payload.inline_study.target_url).toBe('https://example.com/checkout');
  });

  // The failure this closes: a Starting URL typed the way people say addresses
  // out loud was rejected, and the message described the rule rather than the
  // one thing wrong with it.
  it('adds the missing https:// on blur, visibly, and sends the normalised url', async () => {
    renderForm();
    selectType('unmoderated');

    fireEvent.change(screen.getByLabelText(/^Title/i), {
      target: { value: 'Checkout flow walkthrough' }
    });
    fireEvent.change(screen.getByLabelText(/purpose/i), {
      target: { value: 'Find out where people stall in the checkout flow' }
    });

    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add task' }));
    fireEvent.change(screen.getByLabelText(/What the participant sees/i), {
      target: { value: 'Find the export button' }
    });

    const startingUrl = screen.getByLabelText(/Starting URL/i) as HTMLInputElement;
    fireEvent.change(startingUrl, { target: { value: 'example.com/checkout' } });
    fireEvent.blur(startingUrl);

    // Visible in the field, not just corrected on the way to the server: the
    // author has to be able to see what will be stored.
    await vi.waitFor(() => {
      expect(
        (screen.getByLabelText(/Starting URL/i) as HTMLInputElement).value
      ).toBe('https://example.com/checkout');
    });

    fireEvent.click(screen.getByRole('button', { name: /^Create/i }));

    await vi.waitFor(() => {
      expect(vi.mocked(createOpportunity)).toHaveBeenCalled();
    });

    const normalisedPayload = vi.mocked(createOpportunity).mock.calls[0][0] as any;
    expect(normalisedPayload.inline_study.target_url).toBe(
      'https://example.com/checkout'
    );
  });

  it('does not prepend a scheme to an active-scheme url on blur', async () => {
    renderForm();
    selectType('unmoderated');

    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));

    const startingUrl = await screen.findByLabelText(/Starting URL/i);
    fireEvent.change(startingUrl, { target: { value: 'javascript:alert(1)' } });
    fireEvent.blur(startingUrl);

    // Unchanged, so the guard still gets to reject it rather than being handed
    // "https://javascript:alert(1)".
    expect((screen.getByLabelText(/Starting URL/i) as HTMLInputElement).value).toBe(
      'javascript:alert(1)'
    );
  });

  it('will not silently discard a starting url typed with no tasks', async () => {
    renderForm();
    selectType('unmoderated');

    fireEvent.change(screen.getByLabelText(/^Title/i), {
      target: { value: 'Checkout flow walkthrough' }
    });
    fireEvent.change(screen.getByLabelText(/purpose/i), {
      target: { value: 'Find out where people stall in the checkout flow' }
    });

    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));
    fireEvent.change(await screen.findByLabelText(/Starting URL/i), {
      target: { value: 'https://example.com/checkout' }
    });

    fireEvent.click(screen.getByRole('button', { name: /^Create/i }));

    // The payload is only built when a task exists, so without this the URL
    // would vanish and the save would look like it worked.
    expect(
      await screen.findByText(/a starting URL on its own has nothing/i)
    ).toBeInTheDocument();
    expect(vi.mocked(createOpportunity)).not.toHaveBeenCalled();
  });

  it('does not send a stale task list id alongside tasks authored after unticking reuse', async () => {
    // The sequence that silently dropped authored tasks: tick reuse, pick a
    // study, change your mind, untick, write tasks. The id survived in state
    // and won on the backend, discarding everything typed.
    renderForm();
    selectType('unmoderated');

    fireEvent.change(screen.getByLabelText(/^Title/i), {
      target: { value: 'Checkout flow walkthrough' }
    });
    fireEvent.change(screen.getByLabelText(/purpose/i), {
      target: { value: 'Find out where people stall in the checkout flow' }
    });

    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));

    const reuse = await screen.findByLabelText(/Reuse an existing task list/i);
    fireEvent.click(reuse);
    // Anchored to the picker's own label. `/Task list/i` alone also matches the
    // reuse checkbox ("Reuse an existing task list..."), and while the picker is
    // still loading that checkbox is the ONLY match - so the query silently
    // returned it, no study was ever selected, and the assertion below passed
    // against a build with the guard removed.
    // Queried by ROLE, not by label text: the checkbox label reads "Reuse an
    // existing task list...", so any /task list/ label matcher - anchored or
    // not - also matches the checkbox, and `findBy*` returns it. That is how
    // this test was silently disarmed. Role separates them by element type.
    // The option must be awaited too: selecting a value the select does not yet
    // carry is a no-op, which left the picker empty and the assertion vacuous.
    const picker = (await screen.findByRole('combobox', {
      name: /Existing task list/i
    })) as HTMLSelectElement;
    await screen.findByRole('option', { name: /Demo Study/i });
    fireEvent.change(picker, { target: { value: 'study_demo' } });
    expect(picker.value).toBe('study_demo');
    fireEvent.click(reuse);

    fireEvent.click(await screen.findByRole('button', { name: 'Add task' }));
    fireEvent.change(screen.getByLabelText(/What the participant sees/i), {
      target: { value: 'Find the export button' }
    });

    fireEvent.click(screen.getByRole('button', { name: /^Create/i }));

    await vi.waitFor(() => {
      expect(vi.mocked(createOpportunity)).toHaveBeenCalled();
    });

    const payload = vi.mocked(createOpportunity).mock.calls[0][0] as any;
    expect(payload.firsthand_study_id).toBeUndefined();
    expect(payload.inline_study.steps).toEqual([
      { type: 'instruction', prompt: 'Find the export button' }
    ]);
  });

  it('offers inline authoring when editing an unmoderated draft that has no task list yet', async () => {
    vi.mocked(getOpportunity).mockResolvedValueOnce({
      id: 'opp-1',
      type: 'unmoderated',
      title: 'Draft saved early',
      purpose_one_liner: 'Saved before the tasks were written, which is allowed',
      status: 'draft',
      default_duration_minutes: 30,
      firsthand_study_id: null,
      participant_type_required: 'any'
    } as any);

    render(
      <MemoryRouter initialEntries={['/admin/opportunities/opp-1/edit']}>
        <Routes>
          <Route path="/admin/opportunities/:id/edit" element={<OpportunityForm />} />
        </Routes>
      </MemoryRouter>
    );

    fireEvent.click(await screen.findByRole('button', { name: /Task List/i }));

    // Not locked to the picker: the reuse tickbox is offered and authoring is
    // the default, exactly as on create.
    expect(
      await screen.findByLabelText(/Reuse an existing task list/i)
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));
    expect(screen.getByLabelText(/What the participant sees/i)).toBeInTheDocument();
  });

  it('keeps the authored tasks editable after saving, and saves them again in place', async () => {
    // Edit mode stays on the form after saving, so the state has to adopt the
    // study id the server just minted or the next save is answered against a
    // link the form does not know about.
    //
    // What it must NOT do any more is clear the tasks and swap to the picker.
    // That was right while a linked study could not be authored here; A0 now
    // applies the next save to the same study in place, so wiping the author's
    // content one save after they wrote it would reproduce exactly the
    // disappearance A1 exists to stop.
    const draft = {
      id: 'opp-3',
      type: 'unmoderated',
      title: 'Draft saved early',
      purpose_one_liner: 'Saved before the tasks were written, which is allowed',
      status: 'draft',
      default_duration_minutes: 30,
      firsthand_study_id: null,
      participant_type_required: 'any'
    };
    // First read: no study linked yet. Every read AFTER the save sees the study
    // the save minted, because the form now RE-READS instead of declaring that
    // what it sent is what is stored. That re-read is the thing that makes the
    // Save button's disappearance mean something.
    // `as never` rather than `as any`: the suppression file pins the count of
    // no-explicit-any per file, so one more here surfaces every previously
    // suppressed error in this file at once and the lint failure reads as
    // something else entirely.
    vi.mocked(getOpportunity)
      .mockResolvedValueOnce(draft as never)
      .mockResolvedValue({ ...draft, firsthand_study_id: 'study_created_on_save' } as never);
    vi.mocked(getFirstHandStudy).mockResolvedValue(
      linkedStudy({ steps: [{ step_id: 's1', order: 1, type: 'instruction', prompt: 'Find the export button' }] })
    );
    vi.mocked(updateOpportunity).mockResolvedValueOnce({
      id: 'opp-3',
      type: 'unmoderated',
      firsthand_study_id: 'study_created_on_save'
    } as any);

    render(
      <MemoryRouter initialEntries={['/admin/opportunities/opp-3/edit']}>
        <Routes>
          <Route path="/admin/opportunities/:id/edit" element={<OpportunityForm />} />
        </Routes>
      </MemoryRouter>
    );

    fireEvent.click(await screen.findByRole('button', { name: /Task List/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add task' }));
    fireEvent.change(screen.getByLabelText(/What the participant sees/i), {
      target: { value: 'Find the export button' }
    });

    fireEvent.click(screen.getByRole('button', { name: /Update Opportunity/i }));

    await vi.waitFor(() => {
      expect(vi.mocked(updateOpportunity)).toHaveBeenCalled();
    });

    // First save authored the study.
    expect(
      (vi.mocked(updateOpportunity).mock.calls[0][1] as any).inline_study
    ).toBeDefined();

    // The reuse tickbox goes: a study is linked now, so swapping which one this
    // opportunity points at is no longer this form's job. Waited on rather than
    // asserted straight away - updateOpportunity resolving is not the same
    // moment as the state it settles being rendered.
    await vi.waitFor(() =>
      expect(
        screen.queryByLabelText(/Reuse an existing task list/i)
      ).not.toBeInTheDocument()
    );

    // The authored task is still on screen and still editable, and the picker
    // has NOT taken over.
    expect(
      (screen.getByLabelText(/What the participant sees/i) as HTMLTextAreaElement).value
    ).toBe('Find the export button');
    expect(
      screen.queryByText('-- Select a launched task list --')
    ).not.toBeInTheDocument();

    // The point of A1: a LATER save carries the tasks AGAIN, so the edit lands
    // on the same study. Asserting only that the editor is still rendered would
    // pass even if the payload had reverted to sending the id.
    //
    // A real edit is needed to trigger it - an unchanged form saves nothing.
    vi.mocked(updateOpportunity).mockResolvedValueOnce({
      id: 'opp-3',
      type: 'unmoderated',
      firsthand_study_id: 'study_created_on_save'
    } as any);

    fireEvent.click(screen.getByRole('button', { name: /Basic Info/i }));
    fireEvent.change(await screen.findByLabelText(/^Title/i), {
      target: { value: 'Draft saved early, now renamed' }
    });

    // Back to the Task List tab, where the save control lives. It stays disabled
    // while the post-save success banner is up, so wait it out rather than
    // racing it - a click during that window is silently dropped.
    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));
    const saveAgain = await screen.findByRole('button', { name: /Update Opportunity/i });
    await vi.waitFor(() => expect(saveAgain).not.toBeDisabled(), { timeout: 5000 });
    fireEvent.click(saveAgain);

    await vi.waitFor(() => {
      expect(vi.mocked(updateOpportunity)).toHaveBeenCalledTimes(2);
    });

    const secondPayload = vi.mocked(updateOpportunity).mock.calls[1][1] as any;
    expect(secondPayload.inline_study.steps).toEqual([
      { type: 'instruction', prompt: 'Find the export button' }
    ]);
    // Exactly one of the two, never both - the backend refuses a payload
    // carrying an id alongside authored content rather than guessing.
    expect(secondPayload.firsthand_study_id).toBeUndefined();
  });

  it('loads a linked task list into the editor rather than swapping to the picker', async () => {
    // This used to assert the opposite, and the opposite is the defect: a
    // linked list swapped the tab body to the reuse picker, so the content the
    // author had written had nowhere to render and looked like it was never
    // there. The tickbox still goes - swapping WHICH list an opportunity points
    // at is not this form's job once it points at one - but the list itself is
    // now loaded and editable.
    vi.mocked(getFirstHandStudy).mockResolvedValueOnce(linkedStudy());
    vi.mocked(getOpportunity).mockResolvedValueOnce({
      id: 'opp-2',
      type: 'unmoderated',
      title: 'Already wired up',
      purpose_one_liner: 'This one already points at a task list somewhere',
      status: 'draft',
      default_duration_minutes: 30,
      firsthand_study_id: 'study_demo',
      participant_type_required: 'any'
    } as any);

    render(
      <MemoryRouter initialEntries={['/admin/opportunities/opp-2/edit']}>
        <Routes>
          <Route path="/admin/opportunities/:id/edit" element={<OpportunityForm />} />
        </Routes>
      </MemoryRouter>
    );

    fireEvent.click(await screen.findByRole('button', { name: /Task List/i }));

    expect(
      ((await screen.findByLabelText(/What the participant sees/i)) as HTMLTextAreaElement)
        .value
    ).toBe('What did you try first?');
    expect(
      screen.queryByText('-- Select a launched task list --')
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText(/Reuse an existing task list/i)
    ).not.toBeInTheDocument();
  });

  it('still offers the launched-task-list picker when reuse is ticked', async () => {
    renderForm();
    selectType('unmoderated');

    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));
    fireEvent.click(await screen.findByLabelText(/Reuse an existing task list/i));

    expect(
      await screen.findByText('-- Select a launched task list --')
    ).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Demo Study' })).toBeInTheDocument();
    expect(vi.mocked(getFirstHandStudies)).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Silent failures in the authoring form - two live defects (2026-08-14)
//
// Both had the same shape: the author acts, nothing visible happens, and the
// only tell is a console line they will never see. The form spans three tabs,
// so "the problem is on a tab you are not looking at" is the normal case, not
// an edge case.
// ---------------------------------------------------------------------------

describe('locateField', () => {
  it('puts each error key on the tab that actually renders it', () => {
    expect(locateField('title').tab).toBe(1);
    expect(locateField('participant_type_specific_details').tab).toBe(2);
    expect(locateField('external_link_optional').tab).toBe(3);
    expect(locateField('inline_study_consent_text').tab).toBe(3);
  });

  it('names a task by its position, not by its state key', () => {
    // The author never sees "inline_study_steps.0.prompt" anywhere in the UI.
    expect(locateField('inline_study_steps.0.prompt')).toEqual({
      tab: 3,
      label: 'Task 1',
    });
    expect(locateField('inline_study_steps.2.options').label).toBe('Task 3');
  });

  it('falls back to the first tab for a key it does not know', () => {
    // A new validation rule must never route the author nowhere.
    expect(locateField('some_future_field')).toEqual({
      tab: 1,
      label: 'some_future_field',
    });
  });

  it('does not mistake an inherited Object property for a known field', () => {
    // A plain object answers to `constructor`, `toString` and `__proto__` with
    // truthy inherited values, which would sail past a `??` fallback and
    // produce a banner naming no field and no tab to open.
    ['constructor', 'toString', '__proto__', 'hasOwnProperty'].forEach((key) => {
      expect(locateField(key)).toEqual({ tab: 1, label: key });
    });
  });
});

describe('describeValidationFailure', () => {
  it('opens the earliest tab holding a problem, and names every failing field', () => {
    const { tab, message } = describeValidationFailure({
      inline_study_consent_text: 'Consent text is required',
      title: 'Title is required',
    });

    // Earliest, not first-inserted: the object above lists the tab-3 error
    // first, and sending the author to tab 3 would leave the title untouched.
    expect(tab).toBe(1);
    expect(message).toBe('Please fix these fields: Title, Consent text');
  });

  it('names a field once even when it fails twice', () => {
    const { message } = describeValidationFailure({
      'inline_study_steps.0.prompt': 'Add what the participant should see',
      'inline_study_steps.0.options': 'A choice task needs at least two options',
    });
    expect(message).toBe('Please fix these fields: Task 1');
  });

  it('holds the current tab when there is nothing to report', () => {
    expect(describeValidationFailure({})).toEqual({ tab: null, message: '' });
  });
});

describe('FIELD_LOCATIONS completeness', () => {
  // The fallback in locateField degrades gracefully - tab 1, and the raw state
  // key as the label - which means a new validation rule shows the author
  // "Please fix these fields: some_new_key" and routes them to the wrong tab,
  // while every test still passes. Nothing else in the repo catches that: there
  // is no ESLint here and the keys are strings on both sides. So hold the map
  // to the source of truth in both directions.
  // Resolved from the vitest root (frontend/), because import.meta.url is not
  // a file: URL under the jsdom environment.
  const source = readFileSync(resolve(process.cwd(), 'src/pages/OpportunityForm.tsx'), 'utf8');
  const produced = [
    ...new Set(
      [...source.matchAll(/(?:errors|fieldErrors)\.([a-z_]+)\s*=/g)].map((match) => match[1])
    ),
  ].sort();

  it('finds the validation keys it is meant to be checking', () => {
    // Guards the regex itself: if it stops matching, the two tests below pass
    // vacuously against an empty list.
    expect(produced.length).toBeGreaterThanOrEqual(12);
    expect(produced).toContain('title');
    expect(produced).toContain('inline_study_consent_text');
  });

  it('has an entry for every error key the validators can set', () => {
    const missing = produced.filter((key) => !(key in FIELD_LOCATIONS));
    expect(missing).toEqual([]);
  });

  it('has no entry for a field that can never fail', () => {
    // A dead entry looks verified and drifts silently - two of them named
    // fields whose on-screen labels had already changed.
    const dead = Object.keys(FIELD_LOCATIONS).filter((key) => !produced.includes(key));
    expect(dead).toEqual([]);
  });
});

describe('OpportunityForm - a refused action always says so', () => {
  it('sends the author back to the type field instead of no-oping on Continue', async () => {
    // Reachable because the tab headers are directly clickable, which bypasses
    // the guard on tab 1's own Continue. With no type chosen there is no tab 3
    // to continue to, so the button used to setActiveTab(2) from tab 2 - a
    // no-op, with the label silently degraded to a bare "Continue".
    renderForm();

    fireEvent.click(screen.getByRole('button', { name: /Content & Details/i }));
    expect(screen.getByLabelText(/Description \(Optional\)/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Continue/i }));

    expect(
      await screen.findByText('Please fix these fields: Research Study Type')
    ).toBeInTheDocument();
    // Back on the tab that holds the field, with the field itself marked.
    expect(
      screen.getByRole('combobox', { name: /Research Study Type/i })
    ).toBeInvalid();
    expect(screen.getByText('Please select a research study type')).toBeInTheDocument();
    expect(window.scrollTo).toHaveBeenCalled();
  });

  it('says why a save was refused, and opens the tab holding the problem', async () => {
    // The create button only exists on tab 3, so every create is submitted from
    // the furthest tab from Basic Information. A missing title failed
    // validation, logged, and returned - no banner, no scroll, no tab change.
    renderForm();
    selectType('unmoderated');

    fireEvent.change(screen.getByLabelText(/purpose/i), {
      target: { value: 'Find out where people stall in the checkout flow' },
    });

    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add task' }));
    fireEvent.change(screen.getByLabelText(/What the participant sees/i), {
      target: { value: 'Find the export button' },
    });

    fireEvent.click(screen.getByRole('button', { name: /^Create/i }));

    expect(
      await screen.findByText('Please fix these fields: Title')
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/^Title/i)).toBeInvalid();
    expect(screen.getByText('Title is required')).toBeInTheDocument();
    expect(window.scrollTo).toHaveBeenCalled();
    expect(vi.mocked(createOpportunity)).not.toHaveBeenCalled();
  });

  it('opens the middle tab when that is where the problem is', async () => {
    // Guards the routing rather than a hardcoded "go to tab 1": the failing
    // field here is on Content & Details, two tabs from where it was refused.
    renderForm();
    selectType('unmoderated');

    fireEvent.change(screen.getByLabelText(/^Title/i), {
      target: { value: 'Checkout flow walkthrough' },
    });
    fireEvent.change(screen.getByLabelText(/purpose/i), {
      target: { value: 'Find out where people stall in the checkout flow' },
    });

    fireEvent.click(screen.getByRole('button', { name: /Content & Details/i }));
    fireEvent.change(screen.getByLabelText(/Participant Type/i), {
      target: { value: 'specific' },
    });

    // Anchored on the tab's own description: from tab 2 the forward button is
    // named "Continue to Task List", so /Task List/i alone matches both.
    fireEvent.click(
      screen.getByRole('button', { name: /What the participant does/i })
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Add task' }));
    fireEvent.change(screen.getByLabelText(/What the participant sees/i), {
      target: { value: 'Find the export button' },
    });

    fireEvent.click(screen.getByRole('button', { name: /^Create/i }));

    expect(
      await screen.findByText('Please fix these fields: Specific Criteria')
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Specific participant criteria is required when "Specific" is selected'
      )
    ).toBeInTheDocument();
    expect(vi.mocked(createOpportunity)).not.toHaveBeenCalled();
  });

  it('takes the banner away as the author fixes what it named', () => {
    // The banner used to be a second copy of the failure held in its own state,
    // so fixing the field cleared the inline error underneath while the banner
    // went on naming it. Derived now, so it empties itself.
    const { container } = renderForm();

    fireEvent.click(screen.getByRole('button', { name: /Content & Details/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Continue/i }));
    expect(
      screen.getByText('Please fix these fields: Research Study Type')
    ).toBeInTheDocument();

    selectType('poll');

    expect(
      screen.queryByText('Please fix these fields: Research Study Type')
    ).not.toBeInTheDocument();
    // The banner has to GO, not just empty out: rendering the alert box off a
    // flag while its text comes from elsewhere leaves a red bar saying nothing.
    expect(container.querySelector('.alert-danger')).toBeNull();
  });

  it('stays put when the earliest problem is already on the open tab', async () => {
    // Exercises setActiveTab(3) from tab 3 - the routing must not bounce the
    // author to tab 1 just because that is where most fields live.
    renderForm();
    selectType('unmoderated');

    fireEvent.change(screen.getByLabelText(/^Title/i), {
      target: { value: 'Checkout flow walkthrough' },
    });
    fireEvent.change(screen.getByLabelText(/purpose/i), {
      target: { value: 'Find out where people stall in the checkout flow' },
    });

    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add task' }));
    fireEvent.change(screen.getByLabelText(/What the participant sees/i), {
      target: { value: 'Find the export button' },
    });
    fireEvent.change(screen.getByLabelText(/Consent text/i), { target: { value: '  ' } });

    fireEvent.click(screen.getByRole('button', { name: /^Create/i }));

    expect(
      await screen.findByText('Please fix these fields: Consent text')
    ).toBeInTheDocument();
    // Still on the Task List tab, with the field that failed on screen.
    expect(screen.getByLabelText(/Consent text/i)).toBeInTheDocument();
    expect(vi.mocked(createOpportunity)).not.toHaveBeenCalled();
  });

  it('refuses an emptied duration instead of letting the API reject it', async () => {
    // parseInt('') is NaN, and NaN < 5 and NaN > 240 are both false, so a
    // cleared duration passed every client check and came back as an opaque
    // 400 with no field named. Driven through edit mode because Save Changes
    // is the only submit control a test/interview study has outside the
    // session manager.
    vi.mocked(getOpportunity).mockResolvedValueOnce({
      id: 'opp-9',
      type: 'test',
      title: 'Moderated walkthrough',
      purpose_one_liner: 'Watch people work through the new checkout end to end',
      status: 'draft',
      default_duration_minutes: 30,
      meeting_location_optional: 'Zoom',
      participant_type_required: 'any',
    } as any);

    render(
      <MemoryRouter initialEntries={['/admin/opportunities/opp-9/edit']}>
        <Routes>
          <Route path="/admin/opportunities/:id/edit" element={<OpportunityForm />} />
        </Routes>
      </MemoryRouter>
    );

    fireEvent.click(await screen.findByRole('button', { name: /Basic Info/i }));
    fireEvent.change(await screen.findByLabelText(/Default Duration/i), {
      target: { value: '' },
    });

    fireEvent.click(screen.getByRole('button', { name: /Content & Details/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Save Changes/i }));

    expect(
      await screen.findByText('Please fix these fields: Default Duration (minutes)')
    ).toBeInTheDocument();
    expect(screen.getByText('Duration must be between 5 and 240 minutes')).toBeInTheDocument();
    expect(vi.mocked(updateOpportunity)).not.toHaveBeenCalled();
  });
});
