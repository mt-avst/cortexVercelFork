import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import StudyEditor, {
  StudyEditorForm,
  studyMissingTaskPageUrl,
} from '../StudyEditor';
import { isStudyReadOnly } from '../../utils/studyOwnership';
import { NavigationGuardProvider } from '../../contexts/NavigationGuardContext';
import {
  createFirstHandStudy,
  getFirstHandStudy,
  getFirstHandStudyUsage,
  updateFirstHandStudy,
} from '../../api/firsthand-studies';
import { useAuth } from '../../contexts/AuthContext';

// Editor navigation depends on react-router; the CRUD calls are the only side
// effects. Stub the studies client module so no real HTTP is attempted.
vi.mock('../../api/firsthand-studies', () => ({
  createFirstHandStudy: vi.fn().mockResolvedValue({ study: {}, steps: [] }),
  updateFirstHandStudy: vi.fn().mockResolvedValue({ study: {}, steps: [] }),
  getFirstHandStudy: vi.fn(),
  getFirstHandStudyUsage: vi.fn().mockResolvedValue({ count: 0, studies: [] }),
}));

// The page (not the form) reads useAuth. Mocked rather than wrapped in a real
// AuthProvider, which would fetch /me on mount.
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: vi.fn(),
}));

// ConfirmationModal (the unsaved-changes dialog, row 25) reads useTheme; a light
// stub is enough - the dialog's content, not its palette, is what these assert.
vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false }),
}));

const mockedCreate = vi.mocked(createFirstHandStudy);
const mockedUpdate = vi.mocked(updateFirstHandStudy);
const mockedGet = vi.mocked(getFirstHandStudy);
const mockedUsage = vi.mocked(getFirstHandStudyUsage);
const mockedUseAuth = vi.mocked(useAuth) as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockedUsage.mockResolvedValue({ count: 0, studies: [] });
});

const renderForm = (props: Parameters<typeof StudyEditorForm>[0] = {}) =>
  render(
    <MemoryRouter>
      <StudyEditorForm {...props} />
    </MemoryRouter>
  );

/** Fill the fields the shared schema requires so a submit actually reaches the API. */
const fillRequiredFields = (overrides: { title?: string } = {}) => {
  fireEvent.click(screen.getByRole('button', { name: 'Add task' }));
  fireEvent.change(screen.getByLabelText('Title'), {
    target: { value: overrides.title ?? 'A study' },
  });
  fireEvent.change(screen.getByLabelText('Intro text'), {
    target: { value: 'Intro' },
  });
  fireEvent.change(screen.getByLabelText('Consent text'), {
    target: { value: 'Consent' },
  });
  fireEvent.change(screen.getByLabelText('What the participant sees *'), {
    target: { value: 'Do the thing' },
  });
  fireEvent.change(screen.getByLabelText('Starting URL'), {
    target: { value: 'https://example.com/checkout' },
  });
};

// ---------------------------------------------------------------------------
// Pure helper: the missing-task-page-URL gate
// ---------------------------------------------------------------------------
describe('studyMissingTaskPageUrl', () => {
  it('is true when there are tasks but no starting url', () => {
    expect(studyMissingTaskPageUrl([{ type: 'instruction' }], '')).toBe(true);
  });

  it('is false once a starting url is set', () => {
    expect(
      studyMissingTaskPageUrl([{ type: 'instruction' }], 'https://example.com')
    ).toBe(false);
  });

  it('is false with no tasks at all - nothing to miss a page for', () => {
    expect(studyMissingTaskPageUrl([], '')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Create flow
// ---------------------------------------------------------------------------
describe('StudyEditorForm - create', () => {
  it('renders the create action, with no starting task', () => {
    renderForm();
    expect(
      screen.getByRole('button', { name: /Create task list/i })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/No tasks yet\. Add the first thing/i)
    ).toBeInTheDocument();
  });

  it('warns and blocks submit when a task has no starting url, then unblocks on acknowledgement', () => {
    renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));
    expect(screen.getByText('No task page URL set')).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: /Create task list/i });
    expect(submit).toBeDisabled();

    fireEvent.click(
      screen.getByLabelText('This task list has no task page on purpose')
    );
    expect(submit).not.toBeDisabled();
  });

  it('submits a valid study to createFirstHandStudy, with one study-level starting url', async () => {
    renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Checkout study' },
    });
    fireEvent.change(screen.getByLabelText('Intro text'), {
      target: { value: 'Welcome to the study' },
    });
    fireEvent.change(screen.getByLabelText('Consent text'), {
      target: { value: 'You consent to recording' },
    });
    fireEvent.change(screen.getByLabelText('What the participant sees *'), {
      target: { value: 'Buy a product' },
    });
    fireEvent.change(screen.getByLabelText('Starting URL'), {
      target: { value: 'https://example.com/checkout' },
    });

    fireEvent.click(screen.getByRole('button', { name: /Create task list/i }));

    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));
    const payload = mockedCreate.mock.calls[0][0];
    expect(payload.title).toBe('Checkout study');
    expect(payload.id).toMatch(/^study_/);
    expect(payload.steps[0].target_url).toBe('https://example.com/checkout');
    expect(payload.steps[0].step_id.startsWith(`${payload.id}_`)).toBe(true);
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it('rejects an unsafe starting url client-side (shared url-safety) and does not call the API', async () => {
    renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Unsafe study' },
    });
    fireEvent.change(screen.getByLabelText('Intro text'), {
      target: { value: 'Intro' },
    });
    fireEvent.change(screen.getByLabelText('Consent text'), {
      target: { value: 'Consent' },
    });
    fireEvent.change(screen.getByLabelText('What the participant sees *'), {
      target: { value: 'Open the page' },
    });
    // A javascript: URL is rejected by the shared stepSchema (isSafeTargetUrl),
    // so the editor blocks the save before it ever reaches the API.
    fireEvent.change(screen.getByLabelText('Starting URL'), {
      target: { value: 'javascript:alert(1)' },
    });

    fireEvent.click(screen.getByRole('button', { name: /Create task list/i }));

    await waitFor(() =>
      expect(screen.getByText(/Could not save task list\./i)).toBeInTheDocument()
    );
    expect(mockedCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Edit flow
// ---------------------------------------------------------------------------
describe('StudyEditorForm - edit', () => {
  it('pre-fills from the initial study and saves via updateFirstHandStudy', async () => {
    renderForm({
      initialStudy: {
        id: 'study_abc',
        title: 'Existing study',
        intro_text: 'Existing intro',
        consent_text: 'Existing consent',
        status: 'launched',
      },
      initialSteps: [
        {
          step_id: 'step_001',
          order: 1,
          type: 'instruction',
          prompt: 'Do the thing',
          target_url: 'https://example.com',
        },
      ],
    });

    expect(screen.getByLabelText('Title')).toHaveValue('Existing study');
    expect(screen.getByLabelText('Starting URL')).toHaveValue('https://example.com');
    const submit = screen.getByRole('button', { name: /Save changes/i });
    fireEvent.click(submit);

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(1));
    expect(mockedUpdate.mock.calls[0][0]).toBe('study_abc');
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  /**
   * Row 3: the standalone editor showed five task cards for a study the
   * wizard shows as four - the fifth was the `_step_end` completion marker,
   * editable and removable there even though no authoring path ever writes
   * one by hand. It is no longer offered as an editable row anywhere in this
   * form (there is no per-task identity field left to render it through) and
   * is still carried through to the save, unedited.
   */
  describe('the completion marker (row 3)', () => {
    const withEndMarker = {
      id: 'study_abc',
      title: 'Existing study',
      intro_text: 'Existing intro',
      consent_text: 'Existing consent',
      status: 'launched' as const,
    };

    const stepsWithEndMarker = [
      {
        step_id: 'study_abc_step_1',
        order: 1,
        type: 'instruction' as const,
        prompt: 'Do the thing',
        target_url: 'https://example.com',
      },
      {
        step_id: 'study_abc_step_end',
        order: 2,
        type: 'end' as const,
        prompt: 'Thanks - that is the end of the study.',
      },
    ];

    it('excludes the end marker from the editable task list', async () => {
      renderForm({ initialStudy: withEndMarker, initialSteps: stepsWithEndMarker });
      // Let the tab's own usage lookup settle before asserting, so its state
      // update lands inside this test rather than warning after it.
      await waitFor(() => expect(mockedUsage).toHaveBeenCalled());

      // One real task, not two - the terminator gets no card of its own.
      const list = screen.getByRole('list', { name: 'tasks in this list' });
      expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    });

    it('still saves the end marker unedited, after the last authored task', async () => {
      renderForm({ initialStudy: withEndMarker, initialSteps: stepsWithEndMarker });

      fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

      await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(1));
      const steps = mockedUpdate.mock.calls[0][1].steps ?? [];
      expect(steps).toHaveLength(2);
      expect(steps[1]).toMatchObject({
        step_id: 'study_abc_step_end',
        type: 'end',
        order: 2,
        prompt: 'Thanks - that is the end of the study.',
      });
    });
  });

  describe('optimistic concurrency', () => {
    const editableStudy = {
      id: 'study_abc',
      title: 'Existing study',
      intro_text: 'Existing intro',
      consent_text: 'Existing consent',
      status: 'launched' as const,
      updated_at: '2026-08-21T09:15:30.123Z',
    };

    const editableSteps = [
      {
        step_id: 'step_001',
        order: 1,
        type: 'instruction' as const,
        prompt: 'Do the thing',
        target_url: 'https://example.com',
      },
    ];

    /** A 409 shaped exactly as PUT /api/firsthand/studies/:studyId answers one. */
    const staleRejection = (currentUpdatedAt = '2026-08-21T10:00:00.000Z') => ({
      response: {
        status: 409,
        data: {
          error: 'stale_study',
          message:
            'Somebody else saved changes to this task list after you opened it. Your edits have not been saved and are still here.',
          current_updated_at: currentUpdatedAt,
        },
      },
    });

    it('sends the updated_at it loaded as the precondition', async () => {
      renderForm({ initialStudy: editableStudy, initialSteps: editableSteps });

      fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

      await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(1));
      expect(
        (mockedUpdate.mock.calls[0][1] as { expected_updated_at?: string })
          .expected_updated_at
      ).toBe('2026-08-21T09:15:30.123Z');
    });

    it('omits the precondition entirely when the study was served without one', async () => {
      // Absent must mean "no claim", not `null` or an empty string. The schema
      // takes `string | undefined`, and a null would 400 the save outright.
      const { updated_at: _absent, ...withoutTimestamp } = editableStudy;
      renderForm({ initialStudy: withoutTimestamp, initialSteps: editableSteps });

      fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

      await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(1));
      expect(mockedUpdate.mock.calls[0][1]).not.toHaveProperty(
        'expected_updated_at'
      );
    });

    it('keeps every local edit when the save is refused as stale', async () => {
      // The whole promise of the refusal. A banner that said "your edits are
      // still here" over a form that had reset them would be worse than no
      // banner at all.
      mockedUpdate.mockRejectedValueOnce(staleRejection());
      renderForm({ initialStudy: editableStudy, initialSteps: editableSteps });

      fireEvent.change(screen.getByLabelText('Title'), {
        target: { value: 'My unsaved title' },
      });
      fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

      await screen.findByText(
        /Somebody else saved this task list while you were editing/i
      );

      expect(screen.getByLabelText('Title')).toHaveValue('My unsaved title');
      expect(screen.getByLabelText('Intro text')).toHaveValue('Existing intro');
    });

    it('offers the saved version in a NEW TAB rather than a reload', async () => {
      // Reloading remounts the form, and every field here comes from a
      // one-shot useState initialiser - so a reload control would discard
      // exactly the edits the refusal exists to protect.
      mockedUpdate.mockRejectedValueOnce(staleRejection());
      renderForm({ initialStudy: editableStudy, initialSteps: editableSteps });

      fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

      const link = await screen.findByRole('link', {
        name: /Open the saved version in a new tab/i,
      });
      expect(link).toHaveAttribute('href', '/admin/studies/study_abc/edit');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    });

    it('saves again against what is now stored, so the author is not locked out', async () => {
      // Without advancing the precondition the second save re-sends the same
      // stale token and is refused again, forever. The author would have no
      // way to keep their own work short of retyping it somewhere else.
      mockedUpdate.mockRejectedValueOnce(staleRejection('2026-08-21T10:00:00.000Z'));
      renderForm({ initialStudy: editableStudy, initialSteps: editableSteps });

      fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));
      await screen.findByText(
        /Somebody else saved this task list while you were editing/i
      );

      fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

      await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(2));
      expect(
        (mockedUpdate.mock.calls[1][1] as { expected_updated_at?: string })
          .expected_updated_at
      ).toBe('2026-08-21T10:00:00.000Z');
    });

    it('does not treat an ordinary failure as a conflict', async () => {
      // The conflict branch reads the STATUS and the error CODE, not the
      // prose. A 400 that happened to mention the same words must still land
      // in the dead-end banner.
      mockedUpdate.mockRejectedValueOnce({
        response: {
          status: 400,
          data: { error: 'update_failed', message: 'Somebody else saved this' },
        },
      });
      renderForm({ initialStudy: editableStudy, initialSteps: editableSteps });

      fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

      await screen.findByText('Could not save task list.');
      expect(
        screen.queryByRole('link', { name: /Open the saved version/i })
      ).toBeNull();
    });

    it('does not treat a different 409 as somebody else saving', async () => {
      // The CODE half of the guard, which nothing exercised: the two negative
      // tests beside this one defeat different halves - one sends a 400, the
      // other a 409 with no current_updated_at - so dropping the
      // `error === 'stale_study'` check left the suite green.
      mockedUpdate.mockRejectedValueOnce({
        response: {
          status: 409,
          data: {
            error: 'duplicate_step_id',
            message: 'Resource already exists',
            current_updated_at: '2026-08-21T10:00:00.000Z'
          }
        }
      });
      renderForm({ initialStudy: editableStudy, initialSteps: editableSteps });

      fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

      await screen.findByText('Could not save task list.');
      expect(
        screen.queryByRole('link', { name: /Open the saved version/i })
      ).toBeNull();
    });

    it('clears the conflict banner once a save goes through', async () => {
      // A banner that outlives its condition is a lie the author stares at for
      // the rest of the session.
      mockedUpdate.mockRejectedValueOnce(staleRejection());
      renderForm({ initialStudy: editableStudy, initialSteps: editableSteps });

      fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));
      await screen.findByText(
        /Somebody else saved this task list while you were editing/i
      );

      fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

      await waitFor(() =>
        expect(
          screen.queryByText(
            /Somebody else saved this task list while you were editing/i
          )
        ).toBeNull()
      );
    });

    it('falls back to the ordinary failure banner for a 409 it cannot recover from', async () => {
      // A 409 with no current_updated_at leaves nothing to advance the
      // precondition to, so offering "save again" would be a lie. Better the
      // generic banner, which at least says something true.
      mockedUpdate.mockRejectedValueOnce({
        response: { status: 409, data: { error: 'stale_study' } },
      });
      renderForm({ initialStudy: editableStudy, initialSteps: editableSteps });

      fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

      await screen.findByText('Could not save task list.');
      expect(
        screen.queryByRole('link', { name: /Open the saved version/i })
      ).toBeNull();
    });
  });

  /**
   * This surface has to carry the consent classification it loaded, or it will
   * silently reclassify studies the day a second template version ships.
   */
  it('carries the consent classification it loaded back into the save', async () => {
    renderForm({
      initialStudy: {
        id: 'study_abc',
        title: 'Existing study',
        intro_text: 'Existing intro',
        consent_text: 'Existing consent',
        status: 'launched',
        consent_template_id: 'recorded-default',
        consent_template_version: 1,
      },
      initialSteps: [
        {
          step_id: 'step_001',
          order: 1,
          type: 'instruction',
          prompt: 'Do the thing',
          target_url: 'https://example.com',
        },
      ],
    });

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Renamed, consent untouched' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(1));
    const payload = mockedUpdate.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.consent_template_id).toBe('recorded-default');
    expect(payload.consent_template_version).toBe(1);
  });

  it('claims nothing for a study already running on custom wording', async () => {
    renderForm({
      initialStudy: {
        id: 'study_abc',
        title: 'Existing study',
        intro_text: 'Existing intro',
        consent_text: 'Wording somebody wrote',
        status: 'launched',
        consent_template_id: 'custom',
        consent_template_version: null,
      },
      initialSteps: [
        {
          step_id: 'step_001',
          order: 1,
          type: 'instruction',
          prompt: 'Do the thing',
          target_url: 'https://example.com',
        },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(1));
    const payload = mockedUpdate.mock.calls[0][1] as Record<string, unknown>;
    // `custom` is the server's answer, never a client assertion - and sending
    // it would be a claim the schema now insists travels with the wording.
    expect('consent_template_id' in payload).toBe(false);
  });

  it('preserves a stored task\'s identity across a save, rather than renumbering it', async () => {
    // Renumbering would detach whatever has already been recorded against the
    // stored step id - see withStoredIdentity in hydrate-study.ts.
    renderForm({
      initialStudy: {
        id: 'study_abc',
        title: 'Existing study',
        intro_text: 'Existing intro',
        consent_text: 'Existing consent',
        status: 'launched',
      },
      initialSteps: [
        {
          step_id: 'study_abc_step_001',
          order: 1,
          type: 'instruction',
          prompt: 'Do the thing',
          target_url: 'https://example.com',
        },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(1));
    const steps = mockedUpdate.mock.calls[0][1].steps ?? [];
    expect(steps[0].step_id).toBe('study_abc_step_001');
  });

  it('gives a freshly created study its own minted id, prefixed onto its step', async () => {
    renderForm();
    fillRequiredFields({ title: 'Prefixed study' });

    fireEvent.click(screen.getByRole('button', { name: /Create task list/i }));
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));

    const payload = mockedCreate.mock.calls[0][0];
    expect(payload.id).toMatch(/^study_/);
    expect(payload.steps[0].step_id.startsWith(`${payload.id}_`)).toBe(true);
  });

  it('re-mints the study id after a failed create, so a retry is not a second collision', async () => {
    mockedCreate.mockRejectedValueOnce(new Error('Network timeout'));

    renderForm();
    fillRequiredFields({ title: 'Retried study' });
    fireEvent.click(screen.getByRole('button', { name: /Create task list/i }));
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: /Create task list/i }));
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(2));

    const first = mockedCreate.mock.calls[0][0];
    const retry = mockedCreate.mock.calls[1][0];

    expect(retry.id).not.toBe(first.id);
    expect(retry.id).toMatch(/^study_/);
  });
});

// ---------------------------------------------------------------------------
// Ownership affordance
//
// The gate is the backend (canWriteStudy in studies-repository.ts, 403 from
// routes/firsthand.ts). These cover the UI half: an author who cannot save
// should be told before they have retyped the consent copy, not after.
// ---------------------------------------------------------------------------
describe('isStudyReadOnly', () => {
  const owner = { id: 'user-owner', role: 'researcher_admin' };
  const intruder = { id: 'user-intruder', role: 'researcher_admin' };
  const superadmin = { id: 'user-super', role: 'superadmin' };

  it('is false for the owner', () => {
    expect(isStudyReadOnly({ owner_user_id: 'user-owner' }, owner)).toBe(false);
  });

  it('is true for another researcher admin', () => {
    expect(isStudyReadOnly({ owner_user_id: 'user-owner' }, intruder)).toBe(
      true
    );
  });

  it('is false for a superadmin', () => {
    expect(isStudyReadOnly({ owner_user_id: 'user-owner' }, superadmin)).toBe(
      false
    );
  });

  it('is false for an unowned legacy study, which the API still accepts', () => {
    expect(isStudyReadOnly({ owner_user_id: null }, intruder)).toBe(false);
    expect(isStudyReadOnly({}, intruder)).toBe(false);
  });

  it('is true when the viewer is not resolved yet, rather than open', () => {
    expect(isStudyReadOnly({ owner_user_id: 'user-owner' }, undefined)).toBe(
      true
    );
  });
});

describe('StudyEditorForm - read only', () => {
  const ownedElsewhere = {
    id: 'study_abc',
    title: 'Someone else’s study',
    intro_text: 'Intro',
    consent_text: 'Original consent',
    status: 'launched' as const,
    owner_user_id: 'user-owner',
  };
  const intruder = { id: 'user-intruder', role: 'researcher_admin' };
  const steps = [
    {
      step_id: 'study_abc_step_001',
      order: 1,
      type: 'instruction' as const,
      prompt: 'Do the thing',
      target_url: 'https://example.com/checkout',
    },
  ];

  it('explains why, and blocks every control, on a study owned elsewhere', () => {
    renderForm({
      initialStudy: ownedElsewhere,
      initialSteps: steps,
      viewer: intruder,
    });

    expect(screen.getByText('Read only')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save changes/i })).toBeDisabled();
    // The whole fieldset, not just the button: the consent copy is the field
    // the attack rewrites, so it must not look editable either.
    expect(screen.getByLabelText('Consent text')).toBeDisabled();
    // The tasks body swaps to a plain read-only list rather than an editor
    // with disabled controls (ReadOnlyStudyContent) - there is no "Add task"
    // to disable in the first place.
    expect(screen.queryByRole('button', { name: /Add task/i })).not.toBeInTheDocument();
    expect(screen.getByTestId('read-only-study-content')).toBeInTheDocument();
  });

  it('leaves the owner’s own study fully editable', async () => {
    renderForm({
      initialStudy: ownedElsewhere,
      initialSteps: steps,
      viewer: { id: 'user-owner', role: 'researcher_admin' },
    });
    // Let the tab's own usage lookup settle before asserting, so its state
    // update lands inside this test rather than warning after it.
    await waitFor(() => expect(mockedUsage).toHaveBeenCalled());

    expect(screen.queryByText('Read only')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Consent text')).toBeEnabled();
    expect(
      screen.getByRole('button', { name: /Save changes/i })
    ).not.toBeDisabled();
  });

  it('never blocks the create form, which has no owner yet', () => {
    renderForm({ viewer: intruder });

    expect(screen.queryByText('Read only')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Consent text')).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------
// The page, not the form
// ---------------------------------------------------------------------------
describe('StudyEditor page', () => {
  const renderPage = () =>
    render(
      <MemoryRouter initialEntries={['/admin/studies/study_abc/edit']}>
        <Routes>
          <Route path="/admin/studies/:id/edit" element={<StudyEditor />} />
        </Routes>
      </MemoryRouter>
    );

  it('opens on the read-only detail view for an existing list', async () => {
    mockedUseAuth.mockReturnValue({
      user: { id: 'user-owner', role: 'researcher_admin' },
      loading: false,
    });
    mockedGet.mockResolvedValue({
      study: {
        id: 'study_abc',
        title: 'My study',
        intro_text: 'Intro',
        consent_text: 'Consent',
        status: 'launched',
        owner_user_id: 'user-owner',
      },
      steps: [
        {
          step_id: 'study_abc_step_001',
          order: 1,
          type: 'instruction',
          prompt: 'Do the thing',
          target_url: 'https://example.com/checkout',
        },
      ],
    });

    renderPage();

    expect(await screen.findByRole('heading', { name: 'My study' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit this list' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Title')).not.toBeInTheDocument();
  });

  it('shows the real usage count and studies on the detail view (D4/row 12)', async () => {
    mockedUseAuth.mockReturnValue({
      user: { id: 'user-owner', role: 'researcher_admin' },
      loading: false,
    });
    mockedGet.mockResolvedValue({
      study: {
        id: 'study_abc',
        title: 'My study',
        intro_text: 'Intro',
        consent_text: 'Consent',
        status: 'launched',
        owner_user_id: 'user-owner',
      },
      steps: [],
    });
    mockedUsage.mockResolvedValue({
      count: 2,
      studies: [
        { id: 'opp_1', title: 'Checkout study', status: 'published' },
        { id: 'opp_2', title: 'Onboarding study', status: 'draft' },
      ],
    });

    renderPage();

    await screen.findByText(/Used by 2 studies/i);
    expect(mockedUsage).toHaveBeenCalledWith('study_abc');
    expect(screen.getByText(/Checkout study/)).toBeInTheDocument();
    expect(screen.getByText(/Onboarding study/)).toBeInTheDocument();
  });

  it('says nothing uses a list the usage endpoint reports empty', async () => {
    mockedUseAuth.mockReturnValue({
      user: { id: 'user-owner', role: 'researcher_admin' },
      loading: false,
    });
    mockedGet.mockResolvedValue({
      study: {
        id: 'study_abc',
        title: 'My study',
        intro_text: 'Intro',
        consent_text: 'Consent',
        status: 'draft',
        owner_user_id: 'user-owner',
      },
      steps: [],
    });
    mockedUsage.mockResolvedValue({ count: 0, studies: [] });

    renderPage();

    expect(
      await screen.findByText(/No studies use this task list yet/i)
    ).toBeInTheDocument();
  });

  it('switches into the wizard\'s Tasks body when "Edit this list" is clicked', async () => {
    mockedUseAuth.mockReturnValue({
      user: { id: 'user-owner', role: 'researcher_admin' },
      loading: false,
    });
    mockedGet.mockResolvedValue({
      study: {
        id: 'study_abc',
        title: 'My study',
        intro_text: 'Intro',
        consent_text: 'Consent',
        status: 'launched',
        owner_user_id: 'user-owner',
      },
      steps: [
        {
          step_id: 'study_abc_step_001',
          order: 1,
          type: 'instruction',
          prompt: 'Do the thing',
          target_url: 'https://example.com/checkout',
        },
      ],
    });

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit this list' }));

    expect(await screen.findByLabelText('Title')).toHaveValue('My study');
    // The task card starts collapsed; its summary carries the prompt.
    expect(screen.getByText('Do the thing')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Save changes/i })
    ).toBeInTheDocument();
  });

  it('does not offer "Edit this list" on a study owned elsewhere', async () => {
    mockedUseAuth.mockReturnValue({
      user: { id: 'user-intruder', role: 'researcher_admin' },
      loading: false,
    });
    mockedGet.mockResolvedValue({
      study: {
        id: 'study_abc',
        title: 'Someone else’s study',
        intro_text: 'Intro',
        consent_text: 'Original consent',
        status: 'launched',
        owner_user_id: 'user-owner',
      },
      steps: [],
    });

    renderPage();

    await screen.findByRole('heading', { name: /Someone else/ });
    expect(
      screen.queryByRole('button', { name: 'Edit this list' })
    ).not.toBeInTheDocument();
  });

  describe('a brand new list', () => {
    const renderNewPage = () =>
      render(
        <MemoryRouter initialEntries={['/admin/studies/new']}>
          <Routes>
            <Route path="/admin/studies/new" element={<StudyEditor />} />
          </Routes>
        </MemoryRouter>
      );

    it('opens straight into the editor - there is nothing yet to view', () => {
      mockedUseAuth.mockReturnValue({
        user: { id: 'user-owner', role: 'researcher_admin' },
        loading: false,
      });

      renderNewPage();

      expect(screen.getByLabelText('Title')).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /Create task list/i })
      ).toBeInTheDocument();
      expect(mockedGet).not.toHaveBeenCalled();
      expect(mockedUsage).not.toHaveBeenCalled();
    });
  });
});

describe('StudyEditor page - unsaved-changes guard (row 25)', () => {
  const OWN_STUDY = {
    id: 'study_abc',
    title: 'My study',
    intro_text: 'Intro',
    consent_text: 'Consent',
    status: 'draft',
    owner_user_id: 'user-owner',
    updated_at: '2026-08-21T09:15:30.123Z',
  };
  const OWN_STEPS = [
    {
      step_id: 'study_abc_step_001',
      order: 1,
      type: 'instruction',
      prompt: 'Do the thing',
      target_url: 'https://example.com/checkout',
    },
  ];

  // Wrapped in NavigationGuardProvider exactly as AppChromeLayout wraps the real
  // route, and with a destination route so a clean Back can actually land.
  const renderGuardedPage = () =>
    render(
      <NavigationGuardProvider>
        <MemoryRouter initialEntries={['/admin/studies/study_abc/edit']}>
          <Routes>
            <Route path="/admin/studies/:id/edit" element={<StudyEditor />} />
            <Route path="/admin/studies" element={<div>Task lists index</div>} />
          </Routes>
        </MemoryRouter>
      </NavigationGuardProvider>
    );

  beforeEach(() => {
    mockedUseAuth.mockReturnValue({
      user: { id: 'user-owner', role: 'researcher_admin' },
      loading: false,
    });
    mockedGet.mockResolvedValue({ study: { ...OWN_STUDY }, steps: [...OWN_STEPS] } as never);
  });

  it('intercepts Back with a confirm dialog once a field has been edited', async () => {
    renderGuardedPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit this list' }));
    const title = await screen.findByLabelText('Title');
    fireEvent.change(title, { target: { value: 'My study, revised' } });

    fireEvent.click(screen.getByRole('link', { name: 'Back to task lists' }));

    // The dialog appears and the navigation was intercepted - still on the editor.
    expect(await screen.findByText('Leave without saving?')).toBeInTheDocument();
    expect(screen.queryByText('Task lists index')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toBeInTheDocument();
  });

  it('lets Back navigate straight through on a clean editor', async () => {
    renderGuardedPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit this list' }));
    await screen.findByLabelText('Title');
    fireEvent.click(screen.getByRole('link', { name: 'Back to task lists' }));

    expect(await screen.findByText('Task lists index')).toBeInTheDocument();
    expect(screen.queryByText('Leave without saving?')).not.toBeInTheDocument();
  });
});

/**
 * Row 35: this page was a bare page (no card) where every wizard screen sits
 * inside one, and its "Add task" button was navy (`btn-secondary` ->
 * `--text-primary` -> `--fs-ink` #14213d in the light theme) against the
 * wizard's own orange `btn-outline-primary` Add task/Add question.
 */
describe('StudyEditor page - shell parity (row 35)', () => {
  const renderPage = () =>
    render(
      <MemoryRouter initialEntries={['/admin/studies/study_abc/edit']}>
        <Routes>
          <Route path="/admin/studies/:id/edit" element={<StudyEditor />} />
        </Routes>
      </MemoryRouter>
    );

  beforeEach(() => {
    mockedUseAuth.mockReturnValue({
      user: { id: 'user-owner', role: 'researcher_admin' },
      loading: false,
    });
    mockedGet.mockResolvedValue({
      study: {
        id: 'study_abc',
        title: 'My study',
        intro_text: 'Intro',
        consent_text: 'Consent',
        status: 'launched',
        owner_user_id: 'user-owner',
      },
      steps: [
        {
          step_id: 'study_abc_step_001',
          order: 1,
          type: 'instruction',
          prompt: 'Do the thing',
          target_url: 'https://example.com/checkout',
        },
      ],
    } as never);
  });

  it('wraps the page content in a card, like every wizard screen', async () => {
    renderPage();

    const heading = await screen.findByRole('heading', { name: 'My study' });
    expect(heading.closest('.card')).not.toBeNull();
  });

  it('shows the study status as a pill, not plain uppercase text', async () => {
    renderPage();

    await screen.findByRole('heading', { name: 'My study' });
    expect(screen.getByText('Published').className).toMatch(/rounded-full/);
  });

  it('gives "Add task" the shared orange token, not the navy secondary button', async () => {
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit this list' }));
    const addTask = await screen.findByRole('button', { name: 'Add task' });
    expect(addTask).toHaveClass('btn-outline-primary');
    expect(addTask).not.toHaveClass('btn-secondary');
  });
});
