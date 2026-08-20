import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityDetail from '../OpportunityDetail';
import { getOpportunity, getRecordedStudyBrief } from '../../api/client';

/**
 * A stored link that is not a web address must never reach an `href`.
 *
 * This is the half of the fix a schema cannot do. `z.string().url()` is not a
 * protocol check - it accepts `javascript:`, `data:` and `vbscript:`, all of
 * which parse as URLs - and this field was rendered straight into the
 * participant-facing call to action. Confirmed by request before the fix:
 * `POST /api/opportunities` with `{ type: 'question', status: 'published',
 * external_link_optional: 'javascript:alert(document.domain)' }` returned 201,
 * and the page rendered `<a href="javascript:...">Answer Question</a>`.
 *
 * Hardening the schema stops a NEW bad value being stored and says nothing
 * about rows already in the table, which is why the render has to decline too.
 * These fixtures therefore describe a row as the API HANDS IT BACK - the state
 * the page must cope with - not a request it would now refuse.
 *
 * ONE accident, not a control, stopped the stored value executing: Chrome
 * refuses a `javascript:` navigation to `target="_blank"`. Removing that
 * attribute in a real browser made the alert fire, reading the app's own
 * origin.
 *
 * A first version of this comment claimed helmet's default CSP was a second
 * layer. It is not: helmet is mounted on the backend, and this page is served
 * by `frontend/nginx.conf`, which sends no Content-Security-Policy in any
 * environment. There was nothing behind the attribute, which is why this test
 * pins the render's own refusal rather than the browser's.
 */

const base = {
  id: 'opp-1',
  type: 'question',
  title: 'One quick question',
  purpose_one_liner: 'A single question, answered somewhere else',
  status: 'published',
  default_duration_minutes: 5,
  participant_type_required: 'any',
  sessions: []
};

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'employee', name: 'E' }, loading: false })
}));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));
vi.mock('../../components/SlowNeuralBackground', () => ({ default: () => null }));
vi.mock('../../components/CalendarGrid', () => ({
  default: () => null,
  CALENDAR_LEGEND_ITEMS: []
}));

vi.mock('../../api/client', () => ({
  getOpportunity: vi.fn(),
  getRecordedStudyBrief: vi.fn(),
  trackOpportunityClick: vi.fn().mockResolvedValue(undefined),
  bookSession: vi.fn(),
  getMyCalendarEvents: vi.fn(async () => []),
  startRecordedStudySession: vi.fn(),
  startSurveySession: vi.fn()
}));

const renderDetail = () =>
  render(
    <MemoryRouter initialEntries={['/opportunities/opp-1']}>
      <Routes>
        <Route path="/opportunities/:id" element={<OpportunityDetail />} />
      </Routes>
    </MemoryRouter>
  );

const load = (link: string) => {
  vi.mocked(getOpportunity).mockResolvedValue({
    ...base,
    external_link_optional: link
  } as never);
};

/** Every href on the page whose scheme this product will not hand a participant. */
const dangerousHrefs = () =>
  Array.from(document.querySelectorAll('[href]'))
    // Coalesced before the filter, not narrowed inside it: a type predicate
    // does not narrow the argument it is testing, which is what the CI
    // typecheck caught and my own run did not.
    .map((element) => element.getAttribute('href') ?? '')
    .filter((href) => /^(javascript|data|vbscript):/i.test(href));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRecordedStudyBrief).mockResolvedValue({
    task_count: 1,
    records_screen_and_voice: true,
    requires_chromium: true,
    estimated_duration_minutes: null
  } as never);
});

describe('a stored link that is not a web address', () => {
  it.each([
    ['javascript:alert(document.domain)'],
    ['data:text/html,<script>alert(1)</script>'],
    ['vbscript:msgbox(1)']
  ])('is never rendered as an href: %s', async (link) => {
    load(link);
    renderDetail();

    // Wait for the page to have actually loaded, so an empty assertion cannot
    // pass against a spinner.
    await screen.findByText('One quick question');

    expect(dangerousHrefs()).toEqual([]);
    /*
     * And the string is not in the document at all. Asserting only on `[href]`
     * would miss it being moved to a `data-` attribute or read back out of the
     * DOM by a click handler.
     */
    expect(document.body.innerHTML).not.toContain(link);
  });

  it('offers a control that says so, rather than one that silently does nothing', async () => {
    load('javascript:alert(1)');
    renderDetail();
    await screen.findByText('One quick question');

    const control = screen.getByRole('button', { name: /no working link/i });
    expect(control).toBeDisabled();
    expect(control).toHaveTextContent('Link unavailable');
    // Not an anchor. The `href` is the thing that must not exist, so a neutered
    // anchor would be the wrong shape even if it did nothing.
    expect(control.tagName).toBe('BUTTON');
  });

  it('says the same thing when there is no link at all, which used to be an href-less anchor', async () => {
    /*
     * A behaviour change by side effect, so it is pinned rather than left to
     * chance. With no link stored, this branch used to render
     * `<a href={undefined}>Answer Question</a>` - an anchor that is not a link,
     * offering a participant something to press that could not work. It now
     * says so. The empty case and the unusable case are the same fact from the
     * participant's side: there is nowhere to go.
     */
    vi.mocked(getOpportunity).mockResolvedValue({ ...base } as never);
    renderDetail();
    await screen.findByText('One quick question');

    expect(
      screen.getByRole('button', { name: /no working link/i })
    ).toBeDisabled();
    expect(
      screen.queryByRole('link', { name: /answer question/i })
    ).not.toBeInTheDocument();
  });

  it.each([
    ['https://example.com/survey'],
    ['http://example.com/survey']
  ])('still renders a real web address as a working link: %s', async (link) => {
    /*
     * The satisfied twin, and it is what stops all of the above passing against
     * a page that has simply stopped offering a call to action at all. Both
     * schemes, because the predicate permits exactly two and a fix that allowed
     * only https would break every stored http link.
     */
    load(link);
    renderDetail();
    await screen.findByText('One quick question');

    const anchor = await waitFor(() =>
      screen.getByRole('link', { name: /answer question/i })
    );
    expect(anchor).toHaveAttribute('href', link);
    expect(anchor).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(
      screen.queryByRole('button', { name: /no working link/i })
    ).not.toBeInTheDocument();
  });
});
