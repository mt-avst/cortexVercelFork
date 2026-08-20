import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import StudySourcePicker from '../StudySourcePicker';
import { getFirstHandStudy } from '../../../api/firsthand-studies';
import type { FirstHandStudyWithSteps } from '../../../api/firsthand-studies';
import type { FirstHandStudy } from '../../../api/types';

vi.mock('../../../api/firsthand-studies', () => ({
  getFirstHandStudy: vi.fn()
}));

const mockedGetFirstHandStudy = vi.mocked(getFirstHandStudy);

const ID_PREFIX = 'survey';

/**
 * Two rows, deliberately different in every field a mutation could swap:
 * different id, title, owner, count and date. A picker read against one row
 * only cannot tell a correct implementation from `studies[0]` hardcoded in
 * place of the row actually being acted on.
 */
const TWO_STUDIES: FirstHandStudy[] = [
  {
    id: 'study-first',
    title: 'Checkout flow',
    intro_text: '',
    consent_text: '',
    owner_user_id: 'user-1',
    authored_step_count: 3,
    updated_at: '2026-01-15T00:00:00.000Z'
  },
  {
    id: 'study-second',
    title: 'Onboarding survey',
    intro_text: '',
    consent_text: '',
    owner_user_id: 'user-2',
    authored_step_count: 1,
    updated_at: '2026-03-02T00:00:00.000Z'
  }
];

interface RenderOverrides {
  studies?: FirstHandStudy[];
  draftCount?: number;
  loading?: boolean;
  fetchError?: string;
  onRetry?: () => void;
  onChoose?: (studyId: string) => Promise<string | null>;
  currentUserId?: string;
  onCancel?: () => void;
}

const renderPicker = (overrides: RenderOverrides = {}) => {
  const onRetry = overrides.onRetry ?? vi.fn();
  const onChoose = overrides.onChoose ?? vi.fn().mockResolvedValue(null);
  render(
    <StudySourcePicker
      studies={overrides.studies ?? TWO_STUDIES}
      draftCount={overrides.draftCount ?? 0}
      loading={overrides.loading ?? false}
      fetchError={overrides.fetchError ?? ''}
      onRetry={onRetry}
      onChoose={onChoose}
      currentUserId={overrides.currentUserId}
      onCancel={overrides.onCancel}
      noun="question"
      setNoun="set of questions"
      idPrefix={ID_PREFIX}
    />
  );
  return { onRetry, onChoose };
};

/**
 * The `<li>` row that carries the given title, whichever position it is at.
 *
 * The title now appears twice inside a row - once in the visible heading and
 * once inside each button's visually-hidden accessible-name span - so this
 * has to tolerate more than one match rather than the single `queryByText`
 * a one-title-per-row layout could get away with.
 */
const rowFor = (title: string): HTMLElement => {
  const rows = screen.getAllByTestId(`${ID_PREFIX}-source-row`);
  const row = rows.find((candidate) => within(candidate).queryAllByText(title).length > 0);
  if (!row) throw new Error(`No row found for "${title}"`);
  return row;
};

const withSteps = (
  steps: FirstHandStudyWithSteps['steps']
): FirstHandStudyWithSteps => ({
  study: {
    id: 'irrelevant',
    title: 'irrelevant',
    intro_text: '',
    consent_text: ''
  },
  steps
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('row-scoped actions', () => {
  /**
   * The repo's signature defect shape: a fixture of one row cannot fail when
   * a handler is hardcoded to `studies[0]`. Two rows, and the SECOND is
   * clicked.
   */
  it('takes a copy of the row that was clicked, not always the first', async () => {
    const { onChoose } = renderPicker();

    fireEvent.click(
      screen.getByRole('button', { name: 'Start from this Onboarding survey' })
    );

    await waitFor(() => expect(onChoose).toHaveBeenCalledWith('study-second'));
    expect(onChoose).not.toHaveBeenCalledWith('study-first');

    // Let the resolved copy settle so the state update it triggers is not
    // left dangling past the end of the test.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Start from this Onboarding survey' })
      ).not.toBeDisabled()
    );
  });

  it('previews the row that was clicked, not always the first', async () => {
    mockedGetFirstHandStudy.mockResolvedValue(withSteps([]));

    renderPicker();

    fireEvent.click(
      screen.getByRole('button', { name: 'Preview Onboarding survey' })
    );

    await waitFor(() => expect(mockedGetFirstHandStudy).toHaveBeenCalledWith('study-second'));
    expect(mockedGetFirstHandStudy).not.toHaveBeenCalledWith('study-first');

    // The second row's toggle reports itself expanded; the first stays shut.
    expect(
      await screen.findByRole('button', { name: 'Hide preview Onboarding survey' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Preview Checkout flow' })
    ).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('preview content', () => {
  it('does not list the completion marker among the previewed questions', async () => {
    mockedGetFirstHandStudy.mockResolvedValue(
      withSteps([
        { step_id: 's1', order: 1, type: 'open_text', prompt: 'What slows you down?' },
        { step_id: 's2', order: 2, type: 'end', prompt: 'Thanks for taking part' }
      ])
    );

    renderPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Preview Checkout flow' }));

    expect(await screen.findByText('What slows you down?')).toBeInTheDocument();
    expect(screen.queryByText('Thanks for taking part')).not.toBeInTheDocument();
  });
});

/**
 * Only one row's PANEL is ever visible at a time - `expandedId` is a single
 * value - but a row's fetch keeps running in the background after the author
 * moves on from it, because nothing cancels it. So two fetches can still be
 * in flight together: one for a row the author has since closed or moved
 * away from, one for whichever row is open now. That overlap is what the
 * by-study keying protects.
 */
describe('a background fetch from a row the author has left', () => {
  /**
   * A: opened, starts a slow fetch, closed again before it resolves. B: then
   * opened, starts its own fetch. If the loading flag were a single shared
   * value rather than one per study, A's `finally` - firing later, once A's
   * slow fetch settles - would clear it out from under B while B's own fetch
   * is still pending, and B would wrongly render its empty state.
   */
  it("does not blank a row's loading state when a different row's stale fetch resolves", async () => {
    let resolveA: (value: FirstHandStudyWithSteps) => void = () => undefined;
    let resolveB: (value: FirstHandStudyWithSteps) => void = () => undefined;
    mockedGetFirstHandStudy.mockImplementation((studyId: string) =>
      studyId === 'study-first'
        ? new Promise((resolve) => {
            resolveA = resolve;
          })
        : new Promise((resolve) => {
            resolveB = resolve;
          })
    );

    renderPicker();

    // Open A, then close it again while its fetch is still pending.
    fireEvent.click(screen.getByRole('button', { name: 'Preview Checkout flow' }));
    await waitFor(() => expect(mockedGetFirstHandStudy).toHaveBeenCalledWith('study-first'));
    fireEvent.click(screen.getByRole('button', { name: 'Hide preview Checkout flow' }));
    expect(
      screen.getByRole('button', { name: 'Preview Checkout flow' })
    ).toHaveAttribute('aria-expanded', 'false');

    // Open B. Its own fetch is now also pending.
    fireEvent.click(screen.getByRole('button', { name: 'Preview Onboarding survey' }));
    await waitFor(() => expect(mockedGetFirstHandStudy).toHaveBeenCalledWith('study-second'));
    expect(
      within(rowFor('Onboarding survey')).getByText('Loading preview...')
    ).toBeInTheDocument();

    // A's stale, backgrounded fetch settles now. It must not touch B's
    // loading state, which is still genuinely pending.
    resolveA(withSteps([]));
    await waitFor(() =>
      expect(
        within(rowFor('Checkout flow')).queryByText('Loading preview...')
      ).not.toBeInTheDocument()
    );
    expect(
      within(rowFor('Onboarding survey')).getByText('Loading preview...')
    ).toBeInTheDocument();
    expect(
      within(rowFor('Onboarding survey')).queryByText(/has nothing in it/)
    ).not.toBeInTheDocument();

    // B's own fetch now settles, and only now may B report its content.
    resolveB(withSteps([{ step_id: 's1', order: 1, type: 'open_text', prompt: 'Q1' }]));
    expect(await within(rowFor('Onboarding survey')).findByText('Q1')).toBeInTheDocument();
  });

  /**
   * Same shape, for the failure path. A's slow fetch fails after the author
   * has moved on to B. The catch used to collapse `expandedId`
   * unconditionally, which would close WHICHEVER row is open now - B, not the
   * row the failure is actually about.
   */
  it("a stale row's failed fetch does not collapse whichever row is open now", async () => {
    let rejectA: (error: Error) => void = () => undefined;
    mockedGetFirstHandStudy.mockImplementation((studyId: string) => {
      if (studyId === 'study-first') {
        return new Promise((_resolve, reject) => {
          rejectA = reject;
        });
      }
      return Promise.resolve(withSteps([{ step_id: 's1', order: 1, type: 'open_text', prompt: 'Q1' }]));
    });

    renderPicker();

    fireEvent.click(screen.getByRole('button', { name: 'Preview Checkout flow' }));
    await waitFor(() => expect(mockedGetFirstHandStudy).toHaveBeenCalledWith('study-first'));
    fireEvent.click(screen.getByRole('button', { name: 'Hide preview Checkout flow' }));

    fireEvent.click(screen.getByRole('button', { name: 'Preview Onboarding survey' }));
    expect(await within(rowFor('Onboarding survey')).findByText('Q1')).toBeInTheDocument();

    rejectA(new Error('network error'));

    // A's own failure is reported on A's row, even though A is collapsed.
    expect(
      await within(rowFor('Checkout flow')).findByText(/Could not load that/)
    ).toBeInTheDocument();

    // B, which never failed and is the row actually open, must stay open.
    expect(
      screen.getByRole('button', { name: 'Hide preview Onboarding survey' })
    ).toHaveAttribute('aria-expanded', 'true');
    expect(within(rowFor('Onboarding survey')).getByText('Q1')).toBeInTheDocument();
  });
});

describe('ownership line', () => {
  it('says "Yours" when the row is owned by the current user', () => {
    renderPicker({
      studies: [TWO_STUDIES[0]],
      currentUserId: 'user-1'
    });

    expect(rowFor('Checkout flow')).toHaveTextContent('Yours');
    expect(rowFor('Checkout flow')).not.toHaveTextContent("Someone else's");
    expect(rowFor('Checkout flow')).not.toHaveTextContent('No owner recorded');
  });

  it("says \"Someone else's\" when the row is owned by a different user", () => {
    renderPicker({
      studies: [TWO_STUDIES[0]],
      currentUserId: 'user-2'
    });

    expect(rowFor('Checkout flow')).toHaveTextContent("Someone else's");
    expect(rowFor('Checkout flow')).not.toHaveTextContent('Yours');
  });

  it('says "No owner recorded" when the row has no owner at all', () => {
    renderPicker({
      studies: [{ ...TWO_STUDIES[0], owner_user_id: null }],
      currentUserId: 'user-1'
    });

    expect(rowFor('Checkout flow')).toHaveTextContent('No owner recorded');
    expect(rowFor('Checkout flow')).not.toHaveTextContent('Yours');
  });
});

describe('question count', () => {
  it('uses the singular noun for a count of one', () => {
    renderPicker({ studies: [{ ...TWO_STUDIES[0], authored_step_count: 1 }] });

    expect(rowFor('Checkout flow')).toHaveTextContent('1 question ');
    expect(rowFor('Checkout flow')).not.toHaveTextContent('1 questions');
  });

  it('pluralises the noun for a count above one', () => {
    renderPicker({ studies: [{ ...TWO_STUDIES[0], authored_step_count: 3 }] });

    expect(rowFor('Checkout flow')).toHaveTextContent('3 questions');
  });

  it('says nothing about a count the server did not send, rather than "0 questions"', () => {
    renderPicker({
      studies: [{ ...TWO_STUDIES[0], authored_step_count: undefined }]
    });

    expect(rowFor('Checkout flow')).not.toHaveTextContent('0 question');
    expect(rowFor('Checkout flow')).not.toHaveTextContent('question');
  });
});

describe('updated date', () => {
  it('shows the formatted update date', () => {
    renderPicker({
      studies: [{ ...TWO_STUDIES[0], updated_at: '2026-01-15T00:00:00.000Z' }]
    });

    expect(rowFor('Checkout flow')).toHaveTextContent('Updated 15 Jan 2026');
  });

  it('says "Never updated" when the date is absent', () => {
    renderPicker({
      studies: [{ ...TWO_STUDIES[0], updated_at: undefined }]
    });

    expect(rowFor('Checkout flow')).toHaveTextContent('Never updated');
  });

  it('says "Never updated" rather than rendering an unparseable date', () => {
    renderPicker({
      studies: [{ ...TWO_STUDIES[0], updated_at: 'not-a-real-date' }]
    });

    expect(rowFor('Checkout flow')).toHaveTextContent('Never updated');
    expect(rowFor('Checkout flow')).not.toHaveTextContent('Invalid Date');
  });
});

describe('loading, error and busy states', () => {
  it('shows a loading indicator instead of the list', () => {
    renderPicker({ loading: true });

    expect(screen.getByText(/Loading set of questions/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Start from/ })).not.toBeInTheDocument();
  });

  it('shows the fetch error and a retry button that calls onRetry', () => {
    const { onRetry } = renderPicker({ fetchError: 'Could not load your studies.' });

    expect(screen.getByText('Could not load your studies.')).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: 'Try again' });
    fireEvent.click(retry);

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  /**
   * `disabled={copyingId !== null}` applies to every row's copy button, not
   * just the one clicked - so a copy in flight on one row must disable the
   * OTHER row's button too, and re-enable both once it settles.
   */
  it('disables every copy button while a copy is in flight, and re-enables them once it resolves', async () => {
    let resolveChoice: (value: string | null) => void = () => undefined;
    const onChoose = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          resolveChoice = resolve;
        })
    );
    renderPicker({ onChoose });

    fireEvent.click(
      screen.getByRole('button', { name: 'Start from this Checkout flow' })
    );

    expect(
      await within(rowFor('Checkout flow')).findByText('Copying...')
    ).toBeInTheDocument();
    expect(
      within(rowFor('Onboarding survey')).getByRole('button', { name: 'Start from this Onboarding survey' })
    ).toBeDisabled();

    resolveChoice(null);

    await waitFor(() =>
      expect(
        within(rowFor('Onboarding survey')).getByRole('button', { name: 'Start from this Onboarding survey' })
      ).not.toBeDisabled()
    );
  });
});

describe('empty state', () => {
  it('mentions the drafts waiting to be launched when there are some', () => {
    renderPicker({ studies: [], draftCount: 4 });

    expect(
      screen.getByText(/Nothing launched to start from yet\. 4 in draft/)
    ).toBeInTheDocument();
  });

  it('says there is nothing to start from when there are no drafts either', () => {
    renderPicker({ studies: [], draftCount: 0 });

    expect(screen.getByText(/^Nothing to start from yet\./)).toBeInTheDocument();
    expect(screen.queryByText(/in draft/)).not.toBeInTheDocument();
  });
});

describe('accessible names', () => {
  it('names each row\'s buttons with its own title, so two rows are distinguishable', () => {
    renderPicker();

    expect(
      screen.getByRole('button', { name: 'Preview Checkout flow' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Preview Onboarding survey' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Start from this Checkout flow' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Start from this Onboarding survey' })
    ).toBeInTheDocument();
  });

  /**
   * The accessible name is built by APPENDING the title to the visible label
   * (a hidden span), not by an `aria-label` that replaces it. An `aria-label`
   * of `Start from ${title}` would satisfy the row-scoping tests above while
   * failing WCAG 2.5.3 (Label in Name), because "Start from Checkout flow"
   * does not contain the visible words "Start from this" a speech-input user
   * would say. Pinned directly, rather than left as an incidental property of
   * the name-scoping tests above.
   */
  it('keeps the visible label a prefix of the accessible name (Label in Name)', () => {
    renderPicker();

    const copyButton = screen.getByRole('button', {
      name: 'Start from this Checkout flow'
    });
    expect(copyButton).toHaveAccessibleName(/^Start from this /);
    expect(copyButton).toHaveTextContent('Start from this');

    const previewButton = screen.getByRole('button', { name: 'Preview Checkout flow' });
    expect(previewButton).toHaveAccessibleName(/^Preview /);
    expect(previewButton).toHaveTextContent('Preview');
  });

  it('points aria-controls at the panel it actually expands', async () => {
    mockedGetFirstHandStudy.mockResolvedValue(withSteps([]));
    renderPicker();

    fireEvent.click(screen.getByRole('button', { name: 'Preview Checkout flow' }));

    const toggle = await screen.findByRole('button', {
      name: 'Hide preview Checkout flow'
    });
    const panelId = toggle.getAttribute('aria-controls');
    expect(panelId).toBeTruthy();
    expect(document.getElementById(panelId as string)).not.toBeNull();
    expect(rowFor('Checkout flow')).toContainElement(
      document.getElementById(panelId as string)
    );
  });
});

describe('cancelling back to what was already copied in', () => {
  it('does not render a cancel control when none is offered', () => {
    renderPicker();

    expect(
      screen.queryByRole('button', { name: /Keep the set of questions already copied in/ })
    ).not.toBeInTheDocument();
  });

  it('renders and calls onCancel when it is offered', () => {
    const onCancel = vi.fn();
    renderPicker({ onCancel });

    fireEvent.click(
      screen.getByRole('button', { name: 'Keep the set of questions already copied in' })
    );

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('a refused copy', () => {
  it('shows the failure inside the row that was clicked, not above the list', async () => {
    const onChoose = vi.fn((studyId: string) =>
      Promise.resolve(studyId === 'study-second' ? 'That set could not be copied.' : null)
    );
    renderPicker({ onChoose });

    fireEvent.click(
      screen.getByRole('button', { name: 'Start from this Onboarding survey' })
    );

    expect(
      await within(rowFor('Onboarding survey')).findByText('That set could not be copied.')
    ).toBeInTheDocument();
    expect(
      within(rowFor('Checkout flow')).queryByText('That set could not be copied.')
    ).not.toBeInTheDocument();
  });
});

/**
 * The chip's whole point on this surface is that it appears BEFORE the copy is
 * taken - a copy inherits the source's consent wording and its classification
 * with it, so "this one runs on custom wording" is something the author needs
 * while choosing, not something to discover on the Consent step afterwards.
 *
 * An independent mutation pass deleted the chip from this surface and nothing
 * failed: the component was covered, its use was not.
 */
describe('StudySourcePicker - consent state', () => {
  it('flags the row that runs on custom consent, and not its neighbour', () => {
    renderPicker({
      studies: [
        { ...TWO_STUDIES[0], consent_template_id: 'recorded-default' },
        { ...TWO_STUDIES[1], consent_template_id: 'custom' }
      ]
    });

    expect(screen.getAllByTestId('consent-state-chip')).toHaveLength(1);

    // Rows carry a testid; find them by that rather than by their title, which
    // also appears inside each row's own buttons ("Start from this ...").
    const rows = screen.getAllByTestId(/-source-row$/);
    expect(rows).toHaveLength(2);

    const flagged = rows.find((row) => row.textContent?.includes('Onboarding survey'));
    const clean = rows.find((row) => row.textContent?.includes('Checkout flow'));

    // The RIGHT row. Asserting only that one chip exists cannot tell a correct
    // render from one that flagged the wrong study.
    expect(flagged!.querySelector('[data-testid="consent-state-chip"]')).not.toBeNull();
    expect(clean!.querySelector('[data-testid="consent-state-chip"]')).toBeNull();
  });
});
