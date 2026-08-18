import { describe, it, expect } from 'vitest';

import {
  getParticipantFacingType,
  getParticipantActionLabel,
  getClosingTime,
  sortByClosingSoonest,
} from '../opportunityUtils';
import type { Opportunity } from '../../api/types';

const opp = (over: Partial<Opportunity>): Opportunity =>
  ({
    id: 'x',
    type: 'poll',
    title: 'T',
    purpose_one_liner: 'P',
    status: 'published',
    default_duration_minutes: 30,
    sessions: [],
    ...over,
  }) as Opportunity;

describe('getParticipantFacingType', () => {
  // The browse list showed the internal taxonomy: UNMODERATED, APP TESTING,
  // QUESTION. "Unmoderated" is a researcher's word for "nobody is watching" and
  // means nothing to the person being asked to take part.
  it.each([
    ['unmoderated', 'Recorded study'],
    ['test', 'Usability test'],
    ['interview', 'Interview'],
    ['poll', 'Quick poll'],
    ['survey', 'Survey'],
    ['question', 'One question'],
  ])('renders %s as %s', (type, expected) => {
    expect(getParticipantFacingType(type)).toBe(expected);
  });

  it('never says "unmoderated" to a participant', () => {
    expect(getParticipantFacingType('unmoderated').toLowerCase()).not.toContain('unmoderated');
  });

  // The API has been seen returning type concatenated with status.
  it('survives a type concatenated with its status', () => {
    expect(getParticipantFacingType('unmoderatedpublished')).toBe('Recorded study');
    expect(getParticipantFacingType('testdraft')).toBe('Usability test');
  });

  it('falls back to something neutral for an unknown type', () => {
    expect(getParticipantFacingType('wat')).toBe('Study');
    expect(getParticipantFacingType(null)).toBe('Study');
  });
});

describe('getParticipantActionLabel', () => {
  // Petra's point: the fork that actually governs the choice is whether you
  // have to turn up at a booked time or can do it whenever. The verb carries it.
  it('promises a booking for the two bookable types, and never for the others', () => {
    expect(getParticipantActionLabel('test')).toBe('Book a time');
    expect(getParticipantActionLabel('interview')).toBe('Book a time');

    for (const type of ['poll', 'survey', 'question', 'unmoderated']) {
      expect(getParticipantActionLabel(type)).not.toContain('Book');
    }
  });

  it.each([
    ['poll', 'Open poll'],
    ['survey', 'Open survey'],
    ['question', 'Answer'],
    ['unmoderated', 'Start recorded study'],
  ])('labels %s as %s', (type, expected) => {
    expect(getParticipantActionLabel(type)).toBe(expected);
  });
});

describe('getClosingTime', () => {
  it('uses the opportunity end date when it has one', () => {
    const t = getClosingTime(opp({ end_date: '2026-09-01T00:00:00.000Z' }));
    expect(t?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  // A bookable study's real deadline is its last slot, which is not the same
  // thing as the recruitment window and is often the only date it carries.
  it('falls back to the last session end when there is no end date', () => {
    const t = getClosingTime(
      opp({
        type: 'test',
        sessions: [
          { end_time: '2026-08-20T10:00:00.000Z' },
          { end_time: '2026-08-25T10:00:00.000Z' },
        ] as Opportunity['sessions'],
      })
    );
    expect(t?.toISOString()).toBe('2026-08-25T10:00:00.000Z');
  });

  it('prefers the explicit end date over the sessions', () => {
    const t = getClosingTime(
      opp({
        end_date: '2026-09-01T00:00:00.000Z',
        sessions: [{ end_time: '2026-08-20T10:00:00.000Z' }] as Opportunity['sessions'],
      })
    );
    expect(t?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('returns null when nothing says when it closes', () => {
    expect(getClosingTime(opp({}))).toBeNull();
  });

  it('treats an unparseable date as unknown rather than as 1970', () => {
    expect(getClosingTime(opp({ end_date: 'not-a-date' }))).toBeNull();
  });
});

describe('sortByClosingSoonest', () => {
  // The list printed "4 days left" and then placed that study last. If urgency
  // is worth rendering it is worth sorting on.
  // Offsets from now, never fixed dates. These three were written as literal
  // 2026 dates chosen to be in the future, and `soon` was 2026-08-18 - so the
  // test passed until that morning arrived and then failed, correctly, because
  // the sort puts an ENDED study last and the fixture had quietly become one.
  // The bug was the fixture, not the sort; moving the literals forward would
  // only have re-armed it.
  const inDays = (days: number) => new Date(Date.now() + days * 86400000).toISOString();

  it('puts the soonest deadline first', () => {
    const sorted = sortByClosingSoonest([
      opp({ id: 'late', end_date: inDays(44) }),
      opp({ id: 'soon', end_date: inDays(1) }),
      opp({ id: 'middle', end_date: inDays(15) }),
    ]);
    expect(sorted.map((o) => o.id)).toEqual(['soon', 'middle', 'late']);
  });

  it('puts studies with no known deadline last, not first', () => {
    const sorted = sortByClosingSoonest([
      opp({ id: 'undated' }),
      opp({ id: 'dated', end_date: inDays(44) }),
    ]);
    expect(sorted.map((o) => o.id)).toEqual(['dated', 'undated']);
  });

  // An ended study has the smallest key of all, so a plain ascending sort put
  // the longest-expired thing on the page at row one. Nothing closes an
  // opportunity automatically - autoCloseOpportunityIfNeeded is only reachable
  // from the /close-if-past route - so published-and-expired is a real state.
  it('sends an ended study to the bottom, not the top', () => {
    const past = new Date(Date.now() - 40 * 86400000).toISOString();
    const soon = new Date(Date.now() + 2 * 86400000).toISOString();
    const later = new Date(Date.now() + 30 * 86400000).toISOString();

    const sorted = sortByClosingSoonest([
      opp({ id: 'ended', end_date: past }),
      opp({ id: 'later', end_date: later }),
      opp({ id: 'soon', end_date: soon }),
    ]);
    expect(sorted.map((o) => o.id)).toEqual(['soon', 'later', 'ended']);
  });

  it('puts an ended study below even one with no known deadline', () => {
    const sorted = sortByClosingSoonest([
      opp({ id: 'ended', end_date: new Date(Date.now() - 86400000).toISOString() }),
      opp({ id: 'undated' }),
    ]);
    expect(sorted.map((o) => o.id)).toEqual(['undated', 'ended']);
  });

  it('orders ended studies among themselves, most recently ended first', () => {
    const sorted = sortByClosingSoonest([
      opp({ id: 'long-ago', end_date: new Date(Date.now() - 90 * 86400000).toISOString() }),
      opp({ id: 'just-ended', end_date: new Date(Date.now() - 86400000).toISOString() }),
    ]);
    expect(sorted.map((o) => o.id)).toEqual(['just-ended', 'long-ago']);
  });

  // V8 preserves input order for equal keys at these lengths, so a `return 0`
  // mutated to `return 1` passes an order-only assertion. Pin equal DATED keys
  // and an interleaving, not just the tail.
  it('keeps two studies closing at the same moment in their given order', () => {
    const same = new Date(Date.now() + 5 * 86400000).toISOString();
    const sorted = sortByClosingSoonest([
      opp({ id: 'first', end_date: same }),
      opp({ id: 'second', end_date: same }),
    ]);
    expect(sorted.map((o) => o.id)).toEqual(['first', 'second']);
  });

  // Stability is spec-guaranteed (ES2019), not something this function
  // implements - an explicit tie-break was tried and removed as unobservable.
  // This is a regression guard against accidentally reintroducing an unstable
  // comparator, at a length past the short-array sort path.
  it('holds the given order across a long list of studies closing at the same moment', () => {
    const same = new Date(Date.now() + 5 * 86400000).toISOString();
    const input = Array.from({ length: 80 }, (_, i) =>
      opp({ id: `same-${String(i).padStart(2, '0')}`, end_date: same })
    );

    const sorted = sortByClosingSoonest(input);

    expect(sorted.map((o) => o.id)).toEqual(input.map((o) => o.id));
  });

  it('interleaves dated and undated by position, not just at the tail', () => {
    const sorted = sortByClosingSoonest([
      opp({ id: 'undated-a' }),
      opp({ id: 'far', end_date: new Date(Date.now() + 30 * 86400000).toISOString() }),
      opp({ id: 'undated-b' }),
      opp({ id: 'near', end_date: new Date(Date.now() + 2 * 86400000).toISOString() }),
    ]);
    expect(sorted.map((o) => o.id)).toEqual(['near', 'far', 'undated-a', 'undated-b']);
  });

  it('keeps undated studies in their original order relative to each other', () => {
    const sorted = sortByClosingSoonest([
      opp({ id: 'a' }),
      opp({ id: 'b' }),
      opp({ id: 'c' }),
    ]);
    expect(sorted.map((o) => o.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the array it was given', () => {
    const input = [
      opp({ id: 'late', end_date: '2026-09-30T00:00:00.000Z' }),
      opp({ id: 'soon', end_date: '2026-08-18T00:00:00.000Z' }),
    ];
    sortByClosingSoonest(input);
    expect(input.map((o) => o.id)).toEqual(['late', 'soon']);
  });
});
