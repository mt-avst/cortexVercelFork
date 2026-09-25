import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import OpportunityDetail from '../OpportunityDetail';
import { getOpportunity, getRecordedStudyBrief } from '../../api/client';

/**
 * cto/AdaptaLabs#164: the admin share block on `OpportunityDetail.tsx`.
 *
 * `OpportunityDetail.startable.test.tsx` covers the participant call-to-action
 * for every OTHER type; none of its fixtures are a test/interview, so it never
 * exercises `ShareOpportunityLink`'s `startable` prop against a session at
 * all. This file is scoped to exactly that: an admin viewing a PUBLISHED live
 * session or interview whose sessions the detail endpoint returns UNFILTERED
 * (confirmed against a real fixture - the endpoint does not drop ended rows),
 * and whose only slots have already ended.
 *
 * `OpportunityDetail.tsx` derives `startable` for these two types from
 * `findPublishProblems` (the same check Review's own preview runs) and
 * passes both it and the reason (`unstartableReason`, via
 * `deriveShareLinkUnstartableReason`) through to `ShareOpportunityLink`, so
 * every test in the first `describe` below pins that against the current
 * behaviour.
 */

const auth = vi.hoisted(() => ({
  value: {
    user: { id: 'admin-1', role: 'researcher_admin', name: 'Admin' },
    loading: false
  } as { user: { id: string; role: string; name: string } | null; loading: boolean }
}));

vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth.value }));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));
vi.mock('../../components/CalendarGrid', () => ({
  default: () => null,
  CALENDAR_LEGEND_ITEMS: []
}));

vi.mock('../../api/client', () => ({
  getOpportunity: vi.fn(),
  getRecordedStudyBrief: vi.fn(),
  trackOpportunityClick: vi.fn().mockResolvedValue(undefined),
  markOpportunityOpened: vi.fn().mockResolvedValue(undefined),
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

const base = {
  id: 'opp-1',
  type: 'interview',
  title: 'A live session whose slots have all ended',
  purpose_one_liner: 'Thirty minutes on the new dashboard',
  status: 'published',
  default_duration_minutes: 30,
  participant_type_required: 'any',
  // Set so the #164 tests below isolate the SLOT axis on its own - this
  // page's `startable` also gates on the venue, so a fixture with no venue
  // at all would read unstartable for a second, unrelated reason. The
  // dedicated venue-parity `describe` further down clears this field to
  // exercise that axis on its own.
  meeting_location_optional: 'Zoom'
};

const load = (overrides: Record<string, unknown> = {}) => {
  vi.mocked(getOpportunity).mockResolvedValue({ ...base, ...overrides } as never);
};

/** Every session fixture is built off ONE pinned instant, matching the
 * convention `OpportunityForm.broken-upcoming-slot.test.tsx` and
 * `Admin.row-actions-filters.test.tsx` both use - a literal future date is
 * the exact #164 trap ("already ended" once the calendar catches up). */
const NOW = new Date('2026-09-25T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

const sessionAt = (id: string, endOffsetMs: number) => ({
  id,
  opportunity_id: 'opp-1',
  start_time: new Date(NOW.getTime() + endOffsetMs - 30 * 60 * 1000).toISOString(),
  end_time: new Date(NOW.getTime() + endOffsetMs).toISOString(),
  capacity: 1,
  booked_count: 0,
  created_at: new Date(NOW.getTime() - 100 * DAY_MS).toISOString(),
  updated_at: new Date(NOW.getTime() - 100 * DAY_MS).toISOString(),
  remaining: 1
});

const endedSession = (id: string) => sessionAt(id, -DAY_MS);
const boundarySession = (id: string) => sessionAt(id, 0);
const upcomingSession = (id: string) => sessionAt(id, DAY_MS);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  auth.value = {
    user: { id: 'admin-1', role: 'researcher_admin', name: 'Admin' },
    loading: false
  };
  vi.mocked(getRecordedStudyBrief).mockResolvedValue({
    task_count: 1,
    records_screen_and_voice: true,
    requires_chromium: true,
    estimated_duration_minutes: null
  } as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('#164 on the detail page: admin share block for a published interview/test with only ended slots', () => {
  it.each(['test', 'interview'])(
    'offers no ready-to-share link, and the same copy as Review (%s)',
    async (type) => {
      load({ type, sessions: [endedSession('sess-1')] });
      renderDetail();
      await screen.findByText(base.title);

      // No live, copyable link - row 5's rule (a non-startable study gets no
      // link at all, never a link plus a warning underneath it).
      expect(
        screen.queryByText(`${window.location.origin}/opportunities/opp-1`)
      ).not.toBeInTheDocument();

      // The same wording Review's ShareOpportunityLink shows for this exact
      // reason (`OpportunityForm.broken-upcoming-slot.test.tsx`), not the
      // generic "session, task list or link" sentence.
      expect(
        screen.getByText(/Add an upcoming session before sharing\./i)
      ).toBeInTheDocument();
    }
  );

  it('a slot ending exactly at now is not upcoming here either (boundary, strictly greater than)', async () => {
    load({ type: 'interview', sessions: [boundarySession('sess-1')] });
    renderDetail();
    await screen.findByText(base.title);

    expect(
      screen.queryByText(`${window.location.origin}/opportunities/opp-1`)
    ).not.toBeInTheDocument();
  });

  it('is not offered to a non-admin either way (role gate, unaffected by #164)', async () => {
    auth.value = { user: { id: 'u1', role: 'employee', name: 'E' }, loading: false };
    load({ type: 'interview', sessions: [upcomingSession('sess-1')] });
    renderDetail();
    await screen.findByText(base.title);

    expect(screen.queryByText('Share this study')).not.toBeInTheDocument();
  });
});

describe('#164 detail-page control: a future, non-ended slot already reads correctly', () => {
  // A control, not a regression case for the ended-slot behaviour above - an
  // upcoming session already clears `findPublishProblems`' slot check today,
  // by construction. Kept for completeness, so a change that broke this
  // direction would fail here rather than only in the ended case above.
  it.each(['test', 'interview'])('offers the ready-to-share link (%s)', async (type) => {
    load({ type, sessions: [upcomingSession('sess-1')] });
    renderDetail();
    await screen.findByText(base.title);

    expect(
      await screen.findByText(`${window.location.origin}/opportunities/opp-1`)
    ).toBeInTheDocument();
  });
});

/**
 * cto/AdaptaLabs#164 venue parity, the detail-page half - see
 * `OpportunityForm.broken-upcoming-slot.test.tsx` for the Review half of the
 * same proof. Venue and slot are independent requirements: a published
 * interview with an upcoming slot and no venue must read Broken on the table
 * and unshareable on Review, not hand out a live, working link from this
 * page - the exact case row 5's "no link plus a warning underneath it" rule
 * exists to prevent, just reached from the venue side instead of the slot
 * side.
 */
describe('#164 venue parity: the detail page names a missing venue same as a missing slot', () => {
  it('an upcoming slot with no venue shows no share link and "Add a meeting location before sharing."', async () => {
    load({ type: 'interview', meeting_location_optional: '', sessions: [upcomingSession('sess-1')] });
    renderDetail();
    await screen.findByText(base.title);

    expect(
      screen.queryByText(`${window.location.origin}/opportunities/opp-1`)
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Add a meeting location before sharing\./i)
    ).toBeInTheDocument();
  });

  it('a whitespace-only venue counts as no venue (`.trim()`)', async () => {
    load({ type: 'interview', meeting_location_optional: '   ', sessions: [upcomingSession('sess-1')] });
    renderDetail();
    await screen.findByText(base.title);

    expect(
      screen.queryByText(`${window.location.origin}/opportunities/opp-1`)
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Add a meeting location before sharing\./i)
    ).toBeInTheDocument();
  });

  it('names BOTH the slot and the venue in one sentence when neither is there', async () => {
    load({ type: 'test', meeting_location_optional: '', sessions: [] });
    renderDetail();
    await screen.findByText(base.title);

    expect(
      screen.queryByText(`${window.location.origin}/opportunities/opp-1`)
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Add an upcoming session and a meeting location before sharing\./i)
    ).toBeInTheDocument();
  });

  // This case alone does not distinguish old from new behaviour: `sessions.
  // length > 0` is also true here, so it would pass either way. Kept because
  // it still documents the honest copy alongside the two cases above, which
  // do distinguish the two.
  it('the same copy as Review names the venue, not the generic sentence (row 5 parity)', async () => {
    load({ type: 'interview', meeting_location_optional: '', sessions: [upcomingSession('sess-1')] });
    renderDetail();
    await screen.findByText(base.title);

    expect(
      screen.queryByText(/Add a session, a task list or a link before sharing/i)
    ).not.toBeInTheDocument();
  });
});
