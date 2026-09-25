import { screen, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { getOpportunity, getOpportunityBookings } from '../../api/client';
import { PUBLISH_PROBLEM_MESSAGES } from '@shared/firsthand/publish-readiness';
import { MANAGER_USER, renderOverview, study } from './helpers/opportunity-overview';

/**
 * The Setup status section (cto/AdaptaLabs#163): each independent reason a
 * PUBLISHED study is Broken, one at a time, and its "Edit study" link. This
 * page's own `findPublishProblems` call is deliberately stricter than the
 * table's: `notWorking` reads `publishProblems.length > 0` directly, not
 * the table's benefit-of-the-doubt `isStudyBroken` - so a
 * native survey with no linked questions reads Broken here even though the
 * table (which cannot see the negative) would not flag it. Tracked
 * disagreement: cto/AdaptaLabs#170.
 */
const auth = vi.hoisted(() => ({
  value: { user: { id: 'placeholder', role: 'researcher_admin', name: '', email: '' }, loading: false, initialAuthCheck: true },
}));

vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth.value }));

vi.mock('../../api/client', () => ({
  getOpportunity: vi.fn(),
  getOpportunityBookings: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  auth.value = { user: MANAGER_USER, loading: false, initialAuthCheck: true };
  vi.mocked(getOpportunityBookings).mockResolvedValue([]);
});

const EDIT_HREF = '/admin/opportunities/opp-1/edit';

/**
 * The Setup status card's own problem list, scoped past the Setup status
 * heading - a moderated study with a real session also renders a Sessions
 * `<ul>` on the same page, so an unscoped `role="list"` query is ambiguous
 * the moment a fixture carries one.
 */
const setupList = (): HTMLElement | null => {
  const card = screen.getByRole('heading', { name: 'Setup status' }).closest('.card') as HTMLElement;
  return within(card).queryByRole('list');
};

describe('a live session or interview with no bookable slot', () => {
  it('reads Broken and names the missing slot, with a working Edit study link', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(
      study({
        title: 'No slot study',
        type: 'test',
        status: 'published',
        meeting_location_optional: 'Room 4',
        sessions: [],
      })
    );
    renderOverview();

    expect(await screen.findByText(PUBLISH_PROBLEM_MESSAGES.bookable_slot_required)).toBeInTheDocument();
    // Only the one problem - the venue is set, so that gate does not also fire.
    expect(within(setupList() as HTMLElement).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('Broken')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Fix' })).toHaveAttribute('href', EDIT_HREF);
    expect(screen.getByRole('link', { name: 'Edit study' })).toHaveAttribute('href', EDIT_HREF);
  });
});

describe('a live session or interview with no meeting location', () => {
  it('reads Broken and names the missing venue, with a working Edit study link', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(
      study({
        title: 'No venue study',
        type: 'interview',
        status: 'published',
        meeting_location_optional: undefined,
        sessions: [
          {
            id: 's-1',
            opportunity_id: 'opp-1',
            start_time: '2026-10-05T10:00:00.000Z',
            end_time: '2026-10-05T11:00:00.000Z',
            capacity: 2,
            booked_count: 0,
            remaining: 2,
            created_at: '2026-07-01T10:00:00.000Z',
            updated_at: '2026-07-01T10:00:00.000Z',
          },
        ],
      })
    );
    renderOverview();

    expect(await screen.findByText(PUBLISH_PROBLEM_MESSAGES.meeting_location_required)).toBeInTheDocument();
    expect(within(setupList() as HTMLElement).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('Broken')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Fix' })).toHaveAttribute('href', EDIT_HREF);
    expect(screen.getByRole('link', { name: 'Edit study' })).toHaveAttribute('href', EDIT_HREF);
  });

  it('reports BOTH the slot and the venue when a moderated study is missing each', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(
      study({
        title: 'Missing both',
        type: 'interview',
        status: 'published',
        meeting_location_optional: undefined,
        sessions: [],
      })
    );
    renderOverview();

    expect(await screen.findByText(PUBLISH_PROBLEM_MESSAGES.meeting_location_required)).toBeInTheDocument();
    expect(screen.getByText(PUBLISH_PROBLEM_MESSAGES.bookable_slot_required)).toBeInTheDocument();
    expect(within(setupList() as HTMLElement).getAllByRole('listitem')).toHaveLength(2);
  });
});

describe('a native poll/survey/question with no linked questions', () => {
  it('reads Broken and names the missing question set, with a working Edit study link', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(
      study({
        title: 'No questions study',
        type: 'survey',
        status: 'published',
        delivery_mode: 'native',
        firsthand_study_id: null,
      })
    );
    renderOverview();

    expect(await screen.findByText(PUBLISH_PROBLEM_MESSAGES.native_survey_study_required)).toBeInTheDocument();
    expect(within(setupList() as HTMLElement).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('Broken')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Fix' })).toHaveAttribute('href', EDIT_HREF);
    expect(screen.getByRole('link', { name: 'Edit study' })).toHaveAttribute('href', EDIT_HREF);
  });

  it('is Ready once a study is linked, even with the table\'s own benefit-of-the-doubt case (#170)', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(
      study({
        title: 'Linked survey',
        type: 'survey',
        status: 'published',
        delivery_mode: 'native',
        firsthand_study_id: 'fh-linked',
      })
    );
    renderOverview();

    expect(await screen.findByText('Ready to take part')).toBeInTheDocument();
  });
});

describe('a poll/survey/question handed off externally with no link', () => {
  it('reads Broken and names the missing link, with a working Edit study link', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(
      study({
        title: 'No link study',
        type: 'poll',
        status: 'published',
        delivery_mode: 'external',
        external_link_optional: undefined,
      })
    );
    renderOverview();

    expect(await screen.findByText(PUBLISH_PROBLEM_MESSAGES.external_link_required)).toBeInTheDocument();
    expect(within(setupList() as HTMLElement).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('Broken')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Fix' })).toHaveAttribute('href', EDIT_HREF);
    expect(screen.getByRole('link', { name: 'Edit study' })).toHaveAttribute('href', EDIT_HREF);
  });
});

describe('a draft with the same problems', () => {
  it('lists the same Setup status reasons, but the header pill still reads DRAFT - not Broken', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(
      study({
        title: 'Draft with a gap',
        type: 'poll',
        status: 'draft',
        delivery_mode: 'external',
        external_link_optional: undefined,
      })
    );
    renderOverview();

    // `willBePublished: true` is hardcoded, so Setup status previews what a
    // publish attempt would meet whatever the real status is.
    expect(await screen.findByText(PUBLISH_PROBLEM_MESSAGES.external_link_required)).toBeInTheDocument();
    // `notWorking` requires `status === 'published'` - a draft is never
    // "Broken", it is a draft with a checklist still to clear.
    expect(screen.getByText('DRAFT')).toBeInTheDocument();
    expect(screen.queryByText('Broken')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Fix' })).not.toBeInTheDocument();
  });
});
