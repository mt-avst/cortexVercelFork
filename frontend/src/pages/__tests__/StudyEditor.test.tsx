import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import StudyEditor, {
  StudyEditorForm,
  studyMissingTaskPageUrl,
} from '../StudyEditor';
import { isStudyReadOnly } from '../../utils/studyOwnership';
import {
  createFirstHandStudy,
  getFirstHandStudy,
  updateFirstHandStudy,
} from '../../api/firsthand-studies';
import { useAuth } from '../../contexts/AuthContext';

// Editor navigation depends on react-router; the CRUD calls are the only side
// effects. Stub the studies client module so no real HTTP is attempted.
vi.mock('../../api/firsthand-studies', () => ({
  createFirstHandStudy: vi.fn().mockResolvedValue({ study: {}, steps: [] }),
  updateFirstHandStudy: vi.fn().mockResolvedValue({ study: {}, steps: [] }),
  getFirstHandStudy: vi.fn(),
}));

// The page (not the form) reads useAuth. Mocked rather than wrapped in a real
// AuthProvider, which would fetch /me on mount.
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: vi.fn(),
}));

const mockedCreate = vi.mocked(createFirstHandStudy);
const mockedUpdate = vi.mocked(updateFirstHandStudy);
const mockedGet = vi.mocked(getFirstHandStudy);
const mockedUseAuth = vi.mocked(useAuth) as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

const renderForm = (props: Parameters<typeof StudyEditorForm>[0] = {}) =>
  render(
    <MemoryRouter>
      <StudyEditorForm {...props} />
    </MemoryRouter>
  );

/** Fill the fields the shared schema requires so a submit actually reaches the API. */
const fillRequiredFields = (overrides: { title?: string } = {}) => {
  fireEvent.change(screen.getByLabelText('Title'), {
    target: { value: overrides.title ?? 'A study' },
  });
  fireEvent.change(screen.getByLabelText('Intro text'), {
    target: { value: 'Intro' },
  });
  fireEvent.change(screen.getByLabelText('Consent text'), {
    target: { value: 'Consent' },
  });
  fireEvent.change(screen.getAllByLabelText('Prompt')[0], {
    target: { value: 'Do the thing' },
  });
  fireEvent.change(screen.getAllByLabelText('Target URL')[0], {
    target: { value: 'https://example.com/checkout' },
  });
};

// ---------------------------------------------------------------------------
// Pure helper: the missing-task-page-URL gate
// ---------------------------------------------------------------------------
describe('studyMissingTaskPageUrl', () => {
  it('is true when a task step has no target url', () => {
    expect(
      studyMissingTaskPageUrl([{ type: 'instruction', target_url: '' }])
    ).toBe(true);
  });

  it('is false when any task step has a target url', () => {
    expect(
      studyMissingTaskPageUrl([
        { type: 'instruction', target_url: 'https://example.com' },
      ])
    ).toBe(false);
  });

  it('ignores end steps (a study of only end steps is not missing a task page)', () => {
    expect(studyMissingTaskPageUrl([{ type: 'end', target_url: '' }])).toBe(
      false
    );
  });
});

// ---------------------------------------------------------------------------
// Create flow
// ---------------------------------------------------------------------------
describe('StudyEditorForm - create', () => {
  it('renders the create action and a first step by default', () => {
    renderForm();
    expect(
      screen.getByRole('button', { name: /Create task list/i })
    ).toBeInTheDocument();
    expect(screen.getByText('Step 1')).toBeInTheDocument();
  });

  it('warns and blocks submit when a task step has no target url, then unblocks on acknowledgement', () => {
    renderForm();
    // Default step is an instruction with no target url -> warning + disabled.
    expect(screen.getByText('No task page URL set')).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: /Create task list/i });
    expect(submit).toBeDisabled();

    fireEvent.click(
      screen.getByLabelText('This task list has no task page on purpose')
    );
    expect(submit).not.toBeDisabled();
  });

  it('submits a valid study to createFirstHandStudy', async () => {
    renderForm();

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Checkout study' },
    });
    fireEvent.change(screen.getByLabelText('Intro text'), {
      target: { value: 'Welcome to the study' },
    });
    fireEvent.change(screen.getByLabelText('Consent text'), {
      target: { value: 'You consent to recording' },
    });
    fireEvent.change(screen.getByLabelText('Prompt'), {
      target: { value: 'Buy a product' },
    });
    fireEvent.change(screen.getByLabelText('Target URL'), {
      target: { value: 'https://example.com/checkout' },
    });

    fireEvent.click(screen.getByRole('button', { name: /Create task list/i }));

    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));
    const payload = mockedCreate.mock.calls[0][0];
    expect(payload.title).toBe('Checkout study');
    expect(payload.steps[0].target_url).toBe('https://example.com/checkout');
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it('rejects an unsafe target URL client-side (shared url-safety) and does not call the API', async () => {
    renderForm();

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Unsafe study' },
    });
    fireEvent.change(screen.getByLabelText('Intro text'), {
      target: { value: 'Intro' },
    });
    fireEvent.change(screen.getByLabelText('Consent text'), {
      target: { value: 'Consent' },
    });
    fireEvent.change(screen.getByLabelText('Prompt'), {
      target: { value: 'Open the page' },
    });
    // A javascript: URL is rejected by the shared stepSchema (isSafeTargetUrl),
    // so the editor blocks the save before it ever reaches the API.
    fireEvent.change(screen.getByLabelText('Target URL'), {
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
    const submit = screen.getByRole('button', { name: /Save changes/i });
    fireEvent.click(submit);

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(1));
    expect(mockedUpdate.mock.calls[0][0]).toBe('study_abc');
    expect(mockedCreate).not.toHaveBeenCalled();
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
   *
   * The server resolves the classification from the wording, and with no claim
   * it can only compare against the CURRENT version. So after a v2, an author
   * who opens a study running on verbatim v1 wording and changes only its
   * TITLE would have the row rewritten to `custom` - approved wording,
   * permanently badged as unapproved, from an edit that never touched consent.
   * Harmless today, invisible until it is expensive, which is exactly why it is
   * pinned now.
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
  // A task step with a target URL, so the unrelated missing-task-page-URL gate
  // is not what disables the submit in these assertions.
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
    expect(screen.getByRole('button', { name: /Add step/i })).toBeDisabled();
  });

  it('leaves the owner’s own study fully editable', () => {
    renderForm({
      initialStudy: ownedElsewhere,
      initialSteps: steps,
      viewer: { id: 'user-owner', role: 'researcher_admin' },
    });

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
// Step id namespacing
//
// `firsthand.study_steps.id` is a GLOBAL `TEXT PRIMARY KEY`, not scoped per
// study, and `insertStudySteps` writes `step_id` straight into it. Position-only
// defaults (`step_001`, `step_002`) therefore made the SECOND study authored
// here fail on a unique violation, surfaced as a misleading 409 "Resource
// already exists" about the study. These tests state the contract that closes
// it: default step ids are unique per study, and unique within one.
// ---------------------------------------------------------------------------
describe('StudyEditorForm - step id namespacing', () => {
  const existingStudy = {
    id: 'study_abc',
    title: 'Existing study',
    intro_text: 'Existing intro',
    consent_text: 'Existing consent',
    status: 'launched',
  } as const;

  it('gives two freshly-created task lists disjoint step ids', async () => {
    const first = renderForm();
    fillRequiredFields({ title: 'First study' });
    fireEvent.click(screen.getByRole('button', { name: /Create task list/i }));
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));
    first.unmount();

    const second = renderForm();
    fillRequiredFields({ title: 'Second study' });
    fireEvent.click(screen.getByRole('button', { name: /Create task list/i }));
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(2));
    second.unmount();

    const firstIds = mockedCreate.mock.calls[0][0].steps.map(
      (step) => step.step_id
    );
    const secondIds = mockedCreate.mock.calls[1][0].steps.map(
      (step) => step.step_id
    );

    expect(firstIds).toHaveLength(1);
    expect(secondIds).toHaveLength(1);
    // The regression: both studies used to default to `step_001`, so the second
    // create hit a primary-key collision on a row the first study owned.
    expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
  });

  it('sends the minted study id on create, and prefixes every step with it', async () => {
    renderForm();
    fillRequiredFields({ title: 'Prefixed study' });
    fireEvent.click(screen.getByRole('button', { name: /Add step/i }));
    fireEvent.change(screen.getAllByLabelText('Prompt')[1], {
      target: { value: 'Second task' },
    });

    fireEvent.click(screen.getByRole('button', { name: /Create task list/i }));
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));

    const payload = mockedCreate.mock.calls[0][0];
    // Without the id on the payload the server mints its own, and the prefix
    // baked into the step ids names a study that does not exist.
    expect(payload.id).toMatch(/^study_/);
    // Pin the whole sequence, not just the prefix: asserting only `startsWith`
    // would accept an id built from a timestamp or a second uuid.
    expect(payload.steps.map((step) => step.step_id)).toEqual([
      `${payload.id}_step_001`,
      `${payload.id}_step_002`,
    ]);
  });

  it('re-mints the study id after a failed create, so a retry is not a second collision', async () => {
    mockedCreate.mockRejectedValueOnce(new Error('Network timeout'));

    renderForm();
    fillRequiredFields({ title: 'Retried study' });
    fireEvent.click(screen.getByRole('button', { name: /Create task list/i }));
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));

    // Retry the identical form.
    fireEvent.click(screen.getByRole('button', { name: /Create task list/i }));
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(2));

    const first = mockedCreate.mock.calls[0][0];
    const retry = mockedCreate.mock.calls[1][0];

    // Without this the study may already be committed under `first.id`, and
    // every retry collides on studies_pkey forever.
    expect(retry.id).not.toBe(first.id);
    expect(retry.id).toMatch(/^study_/);
    // The step ids must follow the new id, or the prefix names a study that
    // does not exist.
    expect(retry.steps.map((step) => step.step_id)).toEqual([
      `${retry.id}_step_001`,
    ]);
  });

  it('does not hand out a sequence held by an id with surrounding whitespace', async () => {
    renderForm({
      initialStudy: existingStudy,
      initialSteps: [
        {
          step_id: 'study_abc_step_001',
          order: 1,
          type: 'instruction',
          prompt: 'One',
          target_url: 'https://example.com',
        },
      ],
    });

    // The payload trims, so a spaced id claims the untrimmed sequence too.
    fireEvent.change(screen.getByLabelText('Step id'), {
      target: { value: '  study_abc_step_002  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Add step/i }));
    fireEvent.change(screen.getAllByLabelText('Prompt')[1], {
      target: { value: 'Second task' },
    });

    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));
    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(1));

    const ids = (mockedUpdate.mock.calls[0][1].steps ?? []).map(
      (step) => step.step_id
    );
    expect(ids).toEqual(['study_abc_step_002', 'study_abc_step_003']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('takes a new step order from the highest in use, not the step count', async () => {
    renderForm({
      initialStudy: existingStudy,
      // Non-contiguous orders are reachable through the API; `validateSteps`
      // rejects a duplicate order but never requires contiguity.
      initialSteps: [
        {
          step_id: 'study_abc_step_001',
          order: 1,
          type: 'instruction',
          prompt: 'One',
          target_url: 'https://example.com',
        },
        {
          step_id: 'study_abc_step_004',
          order: 4,
          type: 'instruction',
          prompt: 'Four',
          target_url: 'https://example.com',
        },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: /Add step/i }));
    fireEvent.change(screen.getAllByLabelText('Prompt')[2], {
      target: { value: 'New task' },
    });

    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));
    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(1));

    const orders = (mockedUpdate.mock.calls[0][1].steps ?? []).map(
      (step) => step.order
    );
    // A count-derived order would repeat 4 and fail with "Duplicate step order".
    expect(orders).toEqual([1, 4, 5]);
  });

  it('gives a step added to an existing study that study\'s prefix, and leaves stored ids alone', async () => {
    renderForm({
      initialStudy: existingStudy,
      initialSteps: [
        {
          // A legacy bare id, written before namespacing existed.
          step_id: 'step_001',
          order: 1,
          type: 'instruction',
          prompt: 'Do the thing',
          target_url: 'https://example.com',
        },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: /Add step/i }));
    fireEvent.change(screen.getAllByLabelText('Prompt')[1], {
      target: { value: 'Second task' },
    });

    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));
    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(1));

    const [studyId, payload] = mockedUpdate.mock.calls[0];
    expect(studyId).toBe('study_abc');
    // Rewriting a stored step id would orphan the responses recorded against it.
    expect(payload.steps?.[0].step_id).toBe('step_001');
    expect(payload.steps?.[1].step_id).toBe('study_abc_step_002');
    // The update route takes the id from the URL; sending one in the body would
    // be an unused, client-controlled primary key.
    expect(Object.prototype.hasOwnProperty.call(payload, 'id')).toBe(false);
  });

  it('still mints a study id where crypto.randomUUID is unavailable', async () => {
    // `randomUUID` is secure-context only, so it is absent over plain http.
    // `getRandomValues` is not, which is what the fallback is built on.
    //
    // It has to be SHADOWED, not deleted: `randomUUID` lives on
    // `Crypto.prototype`, so `delete crypto.randomUUID` removes nothing and the
    // real method shows through - which made an earlier version of this test
    // pass against a build with no fallback at all.
    const hadOwn = Object.prototype.hasOwnProperty.call(crypto, 'randomUUID');
    Object.defineProperty(crypto, 'randomUUID', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    const randomBytes = vi.spyOn(crypto, 'getRandomValues');

    try {
      expect(typeof crypto.randomUUID).not.toBe('function');
      renderForm();
      fillRequiredFields({ title: 'Insecure context study' });
      fireEvent.click(screen.getByRole('button', { name: /Create task list/i }));
      await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));

      const payload = mockedCreate.mock.calls[0][0];
      expect(payload.id).toMatch(
        /^study_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
      expect(payload.steps[0].step_id).toBe(`${payload.id}_step_001`);
      // A CSPRNG, not Math.random: this value becomes a primary key.
      expect(randomBytes).toHaveBeenCalled();
    } finally {
      randomBytes.mockRestore();
      if (!hadOwn) {
        // @ts-expect-error - drop the shadow so the prototype method shows again.
        delete crypto.randomUUID;
      }
    }
  });

  it('does not reissue a step id that a surviving step still holds', async () => {
    renderForm({
      initialStudy: existingStudy,
      initialSteps: [
        {
          step_id: 'study_abc_step_001',
          order: 1,
          type: 'instruction',
          prompt: 'One',
          target_url: 'https://example.com',
        },
        {
          step_id: 'study_abc_step_002',
          order: 2,
          type: 'instruction',
          prompt: 'Two',
          target_url: 'https://example.com',
        },
        {
          step_id: 'study_abc_step_003',
          order: 3,
          type: 'instruction',
          prompt: 'Three',
          target_url: 'https://example.com',
        },
      ],
    });

    // Removing step 1 renumbers the survivors' `order` to 1 and 2 but leaves
    // their ids at _002 and _003, so an id derived from position reissues _003.
    fireEvent.click(screen.getAllByRole('button', { name: /Remove step/i })[0]);
    fireEvent.click(screen.getByRole('button', { name: /Add step/i }));
    fireEvent.change(screen.getAllByLabelText('Prompt')[2], {
      target: { value: 'New task' },
    });

    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));
    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(1));

    const ids = (mockedUpdate.mock.calls[0][1].steps ?? []).map(
      (step) => step.step_id
    );
    expect(ids).toEqual([
      'study_abc_step_002',
      'study_abc_step_003',
      'study_abc_step_004',
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// The page, not the form
//
// Every test above hands StudyEditorForm an explicit `viewer`, so deleting
// `viewer={user}` where the page renders the form would kill the whole
// affordance with a green suite. This renders the page for real, through
// useAuth and the study fetch, so that wire is covered too.
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

  it('passes the signed-in user through, so a study owned elsewhere is read only', async () => {
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

    expect(await screen.findByText('Read only')).toBeInTheDocument();
    expect(screen.getByLabelText('Consent text')).toBeDisabled();
  });

  it('leaves the owner their own study', async () => {
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

    expect(await screen.findByLabelText('Consent text')).toBeEnabled();
    expect(screen.queryByText('Read only')).not.toBeInTheDocument();
  });
});
