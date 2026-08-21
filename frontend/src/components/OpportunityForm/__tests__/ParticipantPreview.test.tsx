import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ParticipantPreview from '../ParticipantPreview';
import { withClientIds } from '../../../lib/opportunity-authoring/client-ids';
import {
  buildRecordedPreview,
  buildSurveyPreview
} from '../../../lib/opportunity-authoring/participant-preview';

/**
 * Mocked at the RUNTIME CLIENT, not at the transport.
 *
 * This is the whole exit criterion of E1 expressed as a unit test. Asserting
 * that `NO_OP_PREVIEW_TRANSPORT` was passed as a prop would prove only that the
 * prop was passed; the thing that must be true is that nothing the preview does
 * reaches the module that writes `participant_responses`. So the assertion is
 * made against that module. If a future change dropped the transport prop, the
 * runner would fall back to its default - which is exactly these functions - and
 * these tests would fail rather than pass quietly.
 */
const saveParticipantResponse = vi.fn();
const sendRuntimeEvent = vi.fn();

vi.mock('../../../lib/recording/runtime-client', () => ({
  saveParticipantResponse: (...args: unknown[]) => saveParticipantResponse(...args),
  sendRuntimeEvent: (...args: unknown[]) => sendRuntimeEvent(...args)
}));

const surveyPreview = buildSurveyPreview({
  title: 'Design system survey',
  introText: 'A few questions.',
  consentText: 'Nothing is recorded.',
  questions: withClientIds([
    { type: 'open_text' as const, prompt: 'What would you change?' },
    {
      type: 'single_choice' as const,
      prompt: 'Which do you use most?',
      options: ['Jira', 'Confluence']
    }
  ])
});

const recordedPreview = buildRecordedPreview({
  title: 'Checkout study',
  introText: 'Two tasks.',
  consentText: 'This records your screen and microphone.',
  steps: withClientIds([
    { type: 'instruction' as const, prompt: 'Open the basket' },
    { type: 'instruction' as const, prompt: 'Find the delivery options' }
  ]),
  targetUrl: 'https://shop.example.com/basket'
});

beforeEach(() => {
  saveParticipantResponse.mockReset().mockResolvedValue(undefined);
  sendRuntimeEvent.mockReset().mockResolvedValue(undefined);
});

describe('a survey preview writes nothing', () => {
  it('answers every question to the end without one runtime call', async () => {
    const user = userEvent.setup();
    render(<ParticipantPreview preview={surveyPreview} onClose={() => {}} />);

    await user.click(screen.getByRole('button', { name: 'Agree and start' }));
    await user.type(screen.getByRole('textbox'), 'The spacing scale');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('radio', { name: 'Jira' }));
    await user.click(screen.getByRole('button', { name: 'Finish' }));

    // Reached the end - so the run really did go through the whole survey
    // rather than stalling on question one, which would make the assertions
    // below true for the wrong reason.
    expect(await screen.findByText('Thank you')).toBeInTheDocument();

    // And the last thing the author reads is TRUE. The runner's own copy says
    // the answers have been recorded, which on this page would contradict the
    // banner three lines above it.
    expect(
      screen.getByText(/Nothing was saved - this was a preview/)
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Your answers have been recorded/)
    ).not.toBeInTheDocument();

    expect(saveParticipantResponse).not.toHaveBeenCalled();
    // Consent, session_started, response_submitted and session_completed all
    // travel on the same transport. None of them may leave either.
    expect(sendRuntimeEvent).not.toHaveBeenCalled();
  });

  it('advances past a question, which a failing transport would not allow', async () => {
    // The runner refuses to advance when a save throws. So "no call was made"
    // and "the answer was accepted" are two different claims, and only holding
    // both proves the preview is usable rather than merely silent.
    const user = userEvent.setup();
    render(<ParticipantPreview preview={surveyPreview} onClose={() => {}} />);

    await user.click(screen.getByRole('button', { name: 'Agree and start' }));
    await user.type(screen.getByRole('textbox'), 'Something');
    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(
      await screen.findByRole('group', { name: 'Which do you use most?' })
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/could not save your answer/i)
    ).not.toBeInTheDocument();
  });
});

describe('the preview says what it is', () => {
  it('states that nothing is saved and nothing is recorded', () => {
    render(<ParticipantPreview preview={surveyPreview} onClose={() => {}} />);

    expect(
      screen.getByRole('heading', { name: 'Preview: what a participant sees' })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Nothing on this page is saved and nothing is recorded/)
    ).toBeInTheDocument();
  });

  it('closes on the button and on Escape', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<ParticipantPreview preview={surveyPreview} onClose={onClose} />);

    await user.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('moves focus to its own heading, because the browser did not', async () => {
    render(<ParticipantPreview preview={surveyPreview} onClose={() => {}} />);

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Preview: what a participant sees' })
      ).toHaveFocus();
    });
  });

});

describe('a recorded study is read through, not run', () => {
  it('shows consent, the starting host and the tasks in order', () => {
    render(<ParticipantPreview preview={recordedPreview} onClose={() => {}} />);

    expect(
      screen.getByText('This records your screen and microphone.')
    ).toBeInTheDocument();
    expect(screen.getByText('shop.example.com')).toBeInTheDocument();

    const tasks = screen.getAllByRole('listitem').map((item) => item.textContent);
    expect(tasks).toEqual(['Open the basket', 'Find the delivery options']);
  });

  it('says plainly that the real session records, and asks for nothing', () => {
    render(<ParticipantPreview preview={recordedPreview} onClose={() => {}} />);

    expect(
      screen.getByText('The real session records screen and microphone.')
    ).toBeInTheDocument();
    // No consent gate, no Agree button: this is a read-through. A control that
    // looked like the start of a recorded session would be the fake recorder
    // the plan refuses.
    expect(
      screen.queryByRole('button', { name: 'Agree and start' })
    ).not.toBeInTheDocument();
    expect(sendRuntimeEvent).not.toHaveBeenCalled();
  });
});

describe('when there is nothing to preview', () => {
  it('explains what to do instead of showing an empty survey', () => {
    render(
      <ParticipantPreview
        preview={buildSurveyPreview({ title: 'T', questions: [] })}
        onClose={() => {}}
      />
    );

    expect(screen.getByText(/There is nothing to preview yet/)).toBeInTheDocument();
  });
});
