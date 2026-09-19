import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect } from 'vitest';

import { OpportunityRow } from '../OpportunityRow';
import type { Opportunity } from '../../api/types';

const opp = (over: Partial<Opportunity>): Opportunity =>
  ({
    id: 'opp-1',
    type: 'unmoderated',
    title: 'Triage a failing Bitbucket pipeline',
    purpose_one_liner: 'Twenty minutes on your own, recorded',
    status: 'published',
    default_duration_minutes: 30,
    participant_type_required: 'any',
    sessions: [],
    ...over,
  }) as Opportunity;

const renderRow = (o: Opportunity) =>
  render(
    <MemoryRouter>
      <OpportunityRow opportunity={o} />
    </MemoryRouter>
  );

describe('OpportunityRow', () => {
  it('shows the title and the purpose one-liner', () => {
    renderRow(opp({}));

    expect(screen.getByText('Triage a failing Bitbucket pipeline')).toBeVisible();
    expect(screen.getByText(/twenty minutes on your own/i)).toBeVisible();
  });

  it('speaks the participant vocabulary, not the internal taxonomy', () => {
    renderRow(opp({ type: 'unmoderated' }));

    expect(screen.getByText('Recorded session')).toBeVisible();
    expect(screen.queryByText(/unmoderated/i)).toBeNull();
  });

  // Petra: twelve cards, twelve click targets, zero affordances. The verb is
  // what tells you whether this costs you a diary slot or five minutes now.
  it('carries a verb saying what taking part involves', () => {
    renderRow(opp({ type: 'test' }));
    expect(screen.getByText('Book a time')).toBeVisible();
  });

  it('never promises a booking for a type that cannot be booked', () => {
    renderRow(opp({ type: 'survey' }));

    expect(screen.getByText('Open survey')).toBeVisible();
    expect(screen.queryByText(/book/i)).toBeNull();
  });

  // Audit row 10: a native survey/poll the viewer has already answered reads
  // "Completed", not a fresh start - the three types that leave no booking now
  // leave a trace on the home row.
  it('reads Completed instead of a start verb once the viewer has answered', () => {
    renderRow(opp({ type: 'survey', completion: { completed: true, completedAt: '2026-09-02T09:00:00.000Z' } }));

    expect(screen.getByText('Completed')).toBeVisible();
    expect(screen.queryByText('Open survey')).toBeNull();
  });

  it('keeps the start verb when completion is absent or unfinished', () => {
    renderRow(opp({ type: 'poll', completion: { completed: false, completedAt: null } }));

    expect(screen.getByText('Open poll')).toBeVisible();
    expect(screen.queryByText('Completed')).toBeNull();
  });

  it('stays one link to the study even when completed', () => {
    renderRow(opp({ type: 'survey', completion: { completed: true, completedAt: null } }));

    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/opportunities/opp-1');
    expect(screen.queryByRole('button')).toBeNull();
  });

  // One interactive element per row. A button nested inside a link is two
  // targets for one destination, and a keyboard user meets both.
  it('is a single link to the study whose name carries the title AND the verb', () => {
    renderRow(opp({ type: 'unmoderated' }));

    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/opportunities/opp-1');
    expect(screen.queryByRole('button')).toBeNull();

    // Queried BY accessible name, not read off textContent: textContent
    // ignores aria-hidden, so an assertion built from it could not see the
    // action being hidden from assistive tech - and that mutation survived.
    // Role queries run the real accessible-name computation.
    expect(
      screen.getByRole('link', { name: /Triage a failing Bitbucket pipeline/i })
    ).toBeVisible();
    expect(
      screen.getByRole('link', { name: /Start recorded session/i })
    ).toBeVisible();
  });

  // The deadline and the eligibility line live inside the link. An explicit
  // aria-label would replace them as the accessible name, so a screen-reader
  // user would lose the one fact the design spends its accent colour on.
  it('does not hide the deadline or the eligibility behind an aria-label', () => {
    renderRow(
      opp({
        end_date: new Date(Date.now() + 2 * 86400000 + 3600000).toISOString(),
        participant_type_required: 'specific',
        participant_type_specific_details: 'Anyone who has run a migration',
      })
    );

    expect(screen.getByRole('link')).not.toHaveAttribute('aria-label');
    // Again by accessible name, so an aria-hidden on the meta list would fail
    // this rather than sliding past on textContent.
    expect(screen.getByRole('link', { name: /2 days left/i })).toBeVisible();
    expect(
      screen.getByRole('link', { name: /Anyone who has run a migration/i })
    ).toBeVisible();
  });

  it('states when it closes', () => {
    // Plus an hour, deliberately: the countdown floors whole days, so an exact
    // multiple of 24h reads as one day fewer the moment any time elapses
    // between constructing this and rendering. Without the margin the
    // assertion is a coin toss.
    const soon = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000).toISOString();
    renderRow(opp({ end_date: soon }));

    expect(screen.getByText(/4 days left/i)).toBeVisible();
  });

  it('says nothing about a deadline when there is none', () => {
    const { container } = renderRow(opp({ end_date: undefined, sessions: [] }));

    // The element, not the string. Asserting only that no text matches /left$/
    // let an unknown deadline render as "Ended" with the suite still green.
    expect(container.querySelector('.opportunity-row__closing')).toBeNull();
    expect(screen.queryByText(/undefined|NaN|Invalid/i)).toBeNull();
  });

  // Duration is only ever authored for test and interview. Every other type
  // carries the column default, so printing it invents a number.
  it('shows a duration for a bookable study, which is the only kind that has one', () => {
    renderRow(opp({ type: 'test', default_duration_minutes: 45 }));

    expect(screen.getByText(/45 min/)).toBeVisible();
  });

  it.each(['poll', 'survey', 'question', 'unmoderated'])(
    'invents no duration for a %s, because none was ever authored',
    (type) => {
      renderRow(opp({ type, default_duration_minutes: 30 }));

      expect(screen.queryByText(/\d+ min/)).toBeNull();
    }
  );

  it('surfaces a specific eligibility requirement without shouting it', () => {
    renderRow(
      opp({
        participant_type_required: 'specific',
        participant_type_specific_details: 'Anyone who has run a migration',
      })
    );

    expect(screen.getByText(/anyone who has run a migration/i)).toBeVisible();
    // The emoji was the loudest thing on the one card that had it.
    expect(screen.queryByText(/🎯/)).toBeNull();
  });

  // 'external' is the one participant_type value that changes whether a given
  // person can take part, and nothing server-side enforces it - so without this
  // an employee meets it for the first time on the detail page.
  it('warns that a study is external-only', () => {
    renderRow(opp({ participant_type_required: 'external' }));

    expect(screen.getByText(/external participants only/i)).toBeVisible();
  });

  it.each(['any', 'internal'])(
    'stays quiet about a %s audience, which was noise on nearly every row',
    (participantType) => {
      renderRow(opp({ participant_type_required: participantType }));

      expect(screen.queryByText(/only/i)).toBeNull();
      expect(screen.queryByText(/open to all/i)).toBeNull();
    }
  );

  it('shows the status only to an admin, and never to a participant', () => {
    const { unmount } = renderRow(opp({ status: 'draft' }));
    expect(screen.queryByText(/draft/i)).toBeNull();
    unmount();

    render(
      <MemoryRouter>
        <OpportunityRow opportunity={opp({ status: 'draft' })} role="researcher_admin" />
      </MemoryRouter>
    );
    expect(screen.getByText(/draft/i)).toBeVisible();
  });

  // The whole reason finding 1 existed: the urgency test compared a SIGNED
  // difference, so an ENDED study satisfied "closes within three days" and the
  // longest-expired thing on the page was painted in the accent colour.
  it('does not paint an ended study as urgent', () => {
    const { container } = renderRow(
      opp({ end_date: new Date(Date.now() - 40 * 86400000).toISOString() })
    );

    expect(screen.getByText(/ended/i)).toBeVisible();
    expect(container.querySelector('.opportunity-row__closing--urgent')).toBeNull();
  });

  // Fix-first row 7 (second-pass review): the action word was derived from
  // the TYPE alone, never from whether the study could still be taken part
  // in - so an opportunity that closed 40 days ago still said "Start
  // recorded session" and linked straight into a study nobody could join.
  it('renders no action word or arrow once a study has ended', () => {
    renderRow(opp({ type: 'unmoderated', end_date: new Date(Date.now() - 40 * 86400000).toISOString() }));

    expect(screen.queryByText(/start recorded session/i)).toBeNull();
    expect(document.querySelector('.opportunity-row__action')).toBeNull();
    // The row stays one link to the (now-closed) study; it just makes no promise.
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('keeps the action word for a study that has not yet ended', () => {
    renderRow(opp({ type: 'unmoderated', end_date: new Date(Date.now() + 4 * 86400000).toISOString() }));

    expect(screen.getByText(/start recorded session/i)).toBeVisible();
  });

  it('marks a study closing within three days as urgent, and an unhurried one not', () => {
    const { container, unmount } = renderRow(
      opp({ end_date: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString() })
    );
    expect(container.querySelector('.opportunity-row__closing--urgent')).not.toBeNull();
    unmount();

    const { container: calm } = renderRow(
      opp({ end_date: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString() })
    );
    expect(calm.querySelector('.opportunity-row__closing--urgent')).toBeNull();
  });

  it('keeps the meta items apart for a screen reader rather than running them together', () => {
    renderRow(opp({ type: 'test', default_duration_minutes: 45, end_date: new Date(Date.now() + 86400000 * 4).toISOString() }));

    const meta = screen.getByTestId('opportunity-row-meta');
    expect(within(meta).getAllByRole('listitem').length).toBeGreaterThan(1);
  });

  it('advertises up to two roles/skills wanted in the meta line', () => {
    renderRow(opp({ target_roles: ['Product Manager', 'ScriptRunner admin'] }));

    const meta = screen.getByTestId('opportunity-row-meta');
    expect(within(meta).getByText('Product Manager, ScriptRunner admin')).toBeVisible();
  });

  it('summarises more than two roles with a +N remainder to keep the row compact', () => {
    renderRow(opp({ target_roles: ['Product Manager', 'Designer', 'QA Engineer', 'Jira admin'] }));

    const meta = screen.getByTestId('opportunity-row-meta');
    expect(within(meta).getByText('Product Manager, Designer +2')).toBeVisible();
  });

  it('shows no roles meta item when none are set', () => {
    renderRow(opp({ target_roles: [] }));

    const meta = screen.getByTestId('opportunity-row-meta');
    expect(within(meta).queryByText(/\+\d/)).toBeNull();
  });
});
