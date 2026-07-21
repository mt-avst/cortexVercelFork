import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { StudyEditorForm, studyMissingTaskPageUrl } from '../StudyEditor';
import {
  createFirstHandStudy,
  updateFirstHandStudy,
} from '../../api/firsthand-studies';

// Editor navigation depends on react-router; the CRUD calls are the only side
// effects. Stub the studies client module so no real HTTP is attempted.
vi.mock('../../api/firsthand-studies', () => ({
  createFirstHandStudy: vi.fn().mockResolvedValue({ study: {}, steps: [] }),
  updateFirstHandStudy: vi.fn().mockResolvedValue({ study: {}, steps: [] }),
  getFirstHandStudy: vi.fn(),
}));

const mockedCreate = vi.mocked(createFirstHandStudy);
const mockedUpdate = vi.mocked(updateFirstHandStudy);

beforeEach(() => {
  vi.clearAllMocks();
});

const renderForm = (props: Parameters<typeof StudyEditorForm>[0] = {}) =>
  render(
    <MemoryRouter>
      <StudyEditorForm {...props} />
    </MemoryRouter>
  );

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
      screen.getByRole('button', { name: /Create study/i })
    ).toBeInTheDocument();
    expect(screen.getByText('Step 1')).toBeInTheDocument();
  });

  it('warns and blocks submit when a task step has no target url, then unblocks on acknowledgement', () => {
    renderForm();
    // Default step is an instruction with no target url -> warning + disabled.
    expect(screen.getByText('No task page URL set')).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: /Create study/i });
    expect(submit).toBeDisabled();

    fireEvent.click(
      screen.getByLabelText('This study has no task page on purpose')
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

    fireEvent.click(screen.getByRole('button', { name: /Create study/i }));

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

    fireEvent.click(screen.getByRole('button', { name: /Create study/i }));

    await waitFor(() =>
      expect(screen.getByText(/Could not save study\./i)).toBeInTheDocument()
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
});
