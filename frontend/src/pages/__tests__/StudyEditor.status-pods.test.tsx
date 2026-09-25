import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { StudyEditorForm } from '../StudyEditor';
import {
  createFirstHandStudy,
  updateFirstHandStudy,
  getFirstHandStudy,
  getFirstHandStudyUsage,
} from '../../api/firsthand-studies';

/**
 * #167: `StudyEditor.test.tsx` never drove the
 * pods at all - making `StudyEditorForm`'s own
 * `onChange` inert (never calling `setStatus`) left the whole suite green.
 * This file is that missing coverage: the three pods, their meaning lines,
 * what each choice actually sends on save (`launched`, not `published` - the
 * task-list wire format `StudyEditor.tsx` maps to `StatusBadge`'s own words
 * only for display), and that a read-only study (`<fieldset disabled>`)
 * disables all three.
 */

vi.mock('../../api/firsthand-studies', () => ({
  createFirstHandStudy: vi.fn().mockResolvedValue({ study: {}, steps: [] }),
  updateFirstHandStudy: vi.fn().mockResolvedValue({ study: {}, steps: [] }),
  getFirstHandStudy: vi.fn(),
  getFirstHandStudyUsage: vi.fn().mockResolvedValue({ count: 0, studies: [] }),
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: vi.fn(),
}));

vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false }),
}));

const mockedCreate = vi.mocked(createFirstHandStudy);
const mockedUpdate = vi.mocked(updateFirstHandStudy);
const mockedUsage = vi.mocked(getFirstHandStudyUsage);
void vi.mocked(getFirstHandStudy);

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

const statusGroup = () => screen.getByRole('radiogroup', { name: 'Status' });
const statusRadio = (name: string) => within(statusGroup()).getByRole('radio', { name });

const fillRequiredFields = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Add task' }));
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'A study' } });
  fireEvent.change(screen.getByLabelText('Intro text'), { target: { value: 'Intro' } });
  fireEvent.change(screen.getByLabelText('Consent text'), { target: { value: 'Consent' } });
  fireEvent.change(screen.getByLabelText('What the participant sees *'), {
    target: { value: 'Do the thing' },
  });
  fireEvent.change(screen.getByLabelText('Starting URL'), {
    target: { value: 'https://example.com/checkout' },
  });
};

describe('StudyEditor - Status pods (#167)', () => {
  it('renders three radios, Draft/Published/Archived, each named for what task-list status actually gates (#167)', () => {
    renderForm();

    const group = statusGroup();
    expect(within(group).getAllByRole('radio')).toHaveLength(3);
    expect(
      within(group).getByRole('radio', { name: 'Draft Not offered when setting up a study' })
    ).toBeInTheDocument();
    expect(
      within(group).getByRole('radio', { name: 'Published Can be added to a study' })
    ).toBeInTheDocument();
    expect(
      within(group).getByRole('radio', {
        name: 'Archived Retired, cannot be added to a study',
      })
    ).toBeInTheDocument();
  });

  it('defaults to Draft checked, and clicking another pod moves the checked radio immediately (an inert onChange must fail this)', () => {
    renderForm();

    expect(statusRadio('Draft Not offered when setting up a study')).toBeChecked();

    fireEvent.click(statusRadio('Published Can be added to a study'));

    expect(statusRadio('Published Can be added to a study')).toBeChecked();
    expect(statusRadio('Draft Not offered when setting up a study')).not.toBeChecked();
    expect(statusRadio('Archived Retired, cannot be added to a study')).not.toBeChecked();
  });

  it('sends "launched" on save when Published is chosen, not "published" (the task-list wire format)', async () => {
    renderForm();
    fillRequiredFields();

    fireEvent.click(statusRadio('Published Can be added to a study'));
    fireEvent.click(screen.getByRole('button', { name: /Create task list/i }));

    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));
    expect(mockedCreate.mock.calls[0][0].status).toBe('launched');
  });

  it('sends "archived" on save when Archived is chosen', async () => {
    renderForm();
    fillRequiredFields();

    fireEvent.click(statusRadio('Archived Retired, cannot be added to a study'));
    fireEvent.click(screen.getByRole('button', { name: /Create task list/i }));

    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));
    expect(mockedCreate.mock.calls[0][0].status).toBe('archived');
  });

  it('keeps sending "draft" on save when the default is left untouched', async () => {
    renderForm();
    fillRequiredFields();

    fireEvent.click(screen.getByRole('button', { name: /Create task list/i }));

    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));
    expect(mockedCreate.mock.calls[0][0].status).toBe('draft');
  });

  it('carries the CHOSEN status through an edit save, not the one the study loaded with', async () => {
    renderForm({
      initialStudy: {
        id: 'study_abc',
        title: 'Existing study',
        intro_text: 'Existing intro',
        consent_text: 'Existing consent',
        status: 'draft',
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

    fireEvent.click(statusRadio('Archived Retired, cannot be added to a study'));
    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(1));
    expect(mockedUpdate.mock.calls[0][1].status).toBe('archived');
  });

  it('disables all three pods, and leaves the checked one checked, on a read-only (owned-elsewhere) study (#167)', async () => {
    renderForm({
      initialStudy: {
        id: 'study_abc',
        title: "Someone else's study",
        intro_text: 'Intro',
        consent_text: 'Original consent',
        status: 'launched',
        owner_user_id: 'user-owner',
      },
      initialSteps: [
        {
          step_id: 'study_abc_step_001',
          order: 1,
          type: 'instruction',
          prompt: 'Do the thing',
          target_url: 'https://example.com/checkout',
        },
      ],
      viewer: { id: 'user-intruder', role: 'researcher_admin' },
    });
    // Read-only swaps the tasks body to ReadOnlyStudyContent (no FirstHandStudyTab
    // mount), which is what fetches usage - so, unlike the editable-owner path,
    // there is no usage call to await here. The read-only notice is the anchor
    // that the disabled fieldset has actually mounted.
    await screen.findByText('Read only');

    const group = statusGroup();
    for (const radio of within(group).getAllByRole('radio')) {
      expect(radio).toBeDisabled();
    }
    // Read-only still shows the study as it actually stands: launched -> the
    // Published pod, not silently reset to Draft.
    expect(statusRadio('Published Can be added to a study')).toBeChecked();
  });
});
