import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityForm from '../OpportunityForm';
import { opportunityFormRoutes } from '../OpportunityForm.routes';
import { studyTypeCard } from './helpers/study-type-picker';

/**
 * E1's participant preview, reached from the authoring form.
 *
 * The unit tests for the adapter and the preview surface live beside those
 * files. What can only be tested here is the thing the whole design turns on:
 * the preview is a CHILD route of the form, so opening it does not unmount the
 * form, so the unsaved draft being previewed survives being looked at. A
 * sibling route would pass every other test in this repo and lose the author's
 * work the first time they used the feature.
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
  updateOpportunity: vi.fn(),
  getOpportunity: vi.fn(),
  getFirstHandStudies: vi.fn(async () => []),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  getSessions: vi.fn(async () => [])
}));

vi.mock('../../api/firsthand-studies', async (importActual) => ({
  ...(await importActual<typeof import('../../api/firsthand-studies')>()),
  getFirstHandStudy: vi.fn()
}));

/**
 * Nothing on the preview may reach the runtime. Mocked here as well as in the
 * component's own test because this is the path a real author takes, and the
 * exit criterion is about that path rather than about a component in isolation.
 */
const saveParticipantResponse = vi.fn();
const sendRuntimeEvent = vi.fn();

vi.mock('../../lib/recording/runtime-client', () => ({
  saveParticipantResponse: (...args: unknown[]) => saveParticipantResponse(...args),
  sendRuntimeEvent: (...args: unknown[]) => sendRuntimeEvent(...args),
  updateRecordingState: vi.fn(),
  fetchRuntimeSession: vi.fn()
}));

/**
 * Everything the preview shows is queried INSIDE the preview.
 *
 * The form stays mounted behind it - hidden, so role queries skip it, but text
 * queries do not - and the collapsed question cards carry the same prompts the
 * preview does. An unscoped `getByText` would match either, which is a query
 * that cannot tell a working preview from one that renders nothing.
 */
const inPreview = () => within(screen.getByTestId('participant-preview'));

/**
 * The SAME route declaration App.tsx mounts, not a copy of it.
 *
 * Restating the shape here was the first version and it could not do its job:
 * delete either nested `preview` child from App.tsx and a restatement still
 * passes, while in the product the URL falls through to the catch-all,
 * redirects to `/`, and unmounts the form - losing the draft. Importing the
 * declaration means this file's assertions are about what actually ships.
 */
const renderForm = () =>
  render(
    <MemoryRouter initialEntries={['/admin/opportunities/new']}>
      <Routes>{opportunityFormRoutes(<OpportunityForm />)}</Routes>
    </MemoryRouter>
  );

const authorOneQuestion = async (
  user: ReturnType<typeof userEvent.setup>,
  prompt: string
) => {
  await user.click(studyTypeCard('survey', 'native'));
  await user.type(screen.getByLabelText(/^Title/i), 'Developer experience pulse');
  await user.type(
    screen.getByLabelText(/^Purpose/i),
    'Ten short questions about the tools you use every day'
  );

  await user.click(screen.getByRole('button', { name: /Questions/i }));
  await user.click(screen.getByRole('button', { name: /^Add question$/i }));
  await user.type(screen.getByLabelText(/What the participant is asked/i), prompt);
};

beforeEach(() => {
  vi.clearAllMocks();
  saveParticipantResponse.mockResolvedValue(undefined);
  sendRuntimeEvent.mockResolvedValue(undefined);
});

describe('opening the preview from the authoring flow', () => {
  it('shows an unsaved question, which is the entire point of the feature', async () => {
    const user = userEvent.setup();
    renderForm();
    await authorOneQuestion(user, 'Which tool slows you down?');

    // Nothing has been saved: `createOpportunity` has never been called.
    await user.click(
      screen.getByRole('button', { name: /Preview participant experience/i })
    );

    expect(await screen.findByTestId('participant-preview')).toBeInTheDocument();
    await user.click(inPreview().getByRole('button', { name: 'Agree and start' }));
    expect(
      inPreview().getByText('Which tool slows you down?')
    ).toBeInTheDocument();
  });

  /**
   * The form is HIDDEN, and hidden is load-bearing rather than cosmetic.
   *
   * Every other assertion in this file is scoped into the preview, which is
   * correct and is also exactly why none of them can see this: strip `hidden`
   * and the inline `display: none` and the whole suite still passes, while an
   * author tabbing off the preview walks into a second, fully interactive copy
   * of the authoring form underneath it - two Finish-shaped buttons, the
   * form's live validation regions reading out again, and a screen reader
   * treating a participant surface and an admin form as one page.
   *
   * Queried UNSCOPED and BY ROLE. Role is the only query family that consults
   * the accessibility tree - `getByLabelText` and `getByText` both match
   * `display: none` content quite happily - so it is the only one that can
   * assert reachability rather than mere presence in the DOM. That distinction
   * is the entire subject of this test.
   */
  it('leaves nothing of the form reachable behind the preview', async () => {
    const user = userEvent.setup();
    renderForm();
    await authorOneQuestion(user, 'Which tool slows you down?');

    await user.click(
      screen.getByRole('button', { name: /Preview participant experience/i })
    );
    await screen.findByTestId('participant-preview');

    // The form's own controls: its step strip, its forward control, and the
    // textbox holding the question being previewed.
    expect(screen.queryByRole('button', { name: /^Continue: /i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Step \d of 5/ })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();

    // Stated as the WHOLE list rather than as absences: the failure that
    // matters here is an extra control appearing, and a set of `queryBy...`
    // nulls cannot see one.
    expect(
      screen.getAllByRole('button').map((button) => button.textContent?.trim())
    ).toEqual(['Close preview', 'Do not agree', 'Agree and start']);
  });

  it('gives the draft back untouched when the preview closes', async () => {
    const user = userEvent.setup();
    renderForm();
    await authorOneQuestion(user, 'Which tool slows you down?');

    await user.click(
      screen.getByRole('button', { name: /Preview participant experience/i })
    );
    await screen.findByTestId('participant-preview');
    await user.click(inPreview().getByRole('button', { name: 'Close preview' }));

    await waitFor(() =>
      expect(screen.queryByTestId('participant-preview')).toBeNull()
    );

    // Still typed, and still OPEN. The expansion state belongs to
    // `QuestionList`, not to this form, so it is the thing an unmounting
    // preview would silently throw away - the author would come back from
    // checking one question to a list of collapsed cards.
    expect(screen.getByLabelText(/What the participant is asked/i)).toHaveValue(
      'Which tool slows you down?'
    );
    // And the steps before it: walking back to Basic Information proves the
    // whole draft survived, not just the step that was on screen.
    await user.click(screen.getByRole('button', { name: /The study/i }));
    expect(await screen.findByLabelText(/^Title/i)).toHaveValue(
      'Developer experience pulse'
    );
  });

  it('writes nothing to the runtime while the author answers their own survey', async () => {
    const user = userEvent.setup();
    renderForm();
    await authorOneQuestion(user, 'Which tool slows you down?');

    await user.click(
      screen.getByRole('button', { name: /Preview participant experience/i })
    );
    await screen.findByTestId('participant-preview');
    await user.click(inPreview().getByRole('button', { name: 'Agree and start' }));
    await user.type(inPreview().getByRole('textbox'), 'The build');
    await user.click(inPreview().getByRole('button', { name: 'Finish' }));

    expect(inPreview().getByText('Thank you')).toBeInTheDocument();
    expect(saveParticipantResponse).not.toHaveBeenCalled();
    expect(sendRuntimeEvent).not.toHaveBeenCalled();
  });

  it('gives focus back to the button that opened it', async () => {
    // A cleanup inside ParticipantPreview looked like the obvious home for
    // this and silently did nothing: React runs a deleted component's effect
    // cleanups before the sibling DOM updates land, so the form was still
    // `display: none` and `focus()` was a no-op. Asserted through the FORM,
    // because the form is what now owns it.
    const user = userEvent.setup();
    renderForm();
    await authorOneQuestion(user, 'Which tool slows you down?');

    const opener = screen.getByRole('button', {
      name: /Preview participant experience/i
    });
    await user.click(opener);
    await screen.findByTestId('participant-preview');
    await user.click(inPreview().getByRole('button', { name: 'Close preview' }));

    await waitFor(() =>
      expect(screen.queryByTestId('participant-preview')).toBeNull()
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Preview participant experience/i })
      ).toHaveFocus()
    );
  });

  it('offers the same entry point on Review', async () => {
    const user = userEvent.setup();
    renderForm();
    await authorOneQuestion(user, 'Which tool slows you down?');

    for (let guard = 0; guard <= 6; guard += 1) {
      const forward = screen.queryByRole('button', { name: /^Continue: /i });
      if (!forward) break;
      await user.click(forward);
    }

    expect(screen.getByTestId('review-step')).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: /Preview participant experience/i })
    );
    expect(await screen.findByTestId('participant-preview')).toBeInTheDocument();
  });
});
