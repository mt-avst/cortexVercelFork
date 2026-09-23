import { describe, it, expect } from '@jest/globals';

import { toPublicOpportunity } from '../publicOpportunity';

/**
 * The serialiser had no test of its own - it was exercised only transitively
 * through the opportunity routes, so nothing stated its contract and nobody
 * noticed it was stripping owner identity while passing the session joining
 * link straight through to anonymous callers.
 *
 * A shared predicate with only transitive coverage is exactly where that class
 * of bug lives.
 */

const opportunity = {
  id: 'opp-1',
  title: 'Checkout flow walkthrough',
  status: 'published',
  external_link_optional: 'https://example.com/survey',
  firsthand_study_id: 'study_abc',
  owner_user_id: 'user-1',
  owner_name: 'A Researcher',
  owner_email: 'researcher@example.com',
  sessions: [
    {
      id: 'sess-1',
      start_time: '2026-09-01T10:00:00.000Z',
      capacity: 3,
      location_or_meet_link_optional: 'https://meet.google.com/abc-defg-hij',
    },
    {
      id: 'sess-2',
      start_time: '2026-09-02T10:00:00.000Z',
      capacity: 3,
      location_or_meet_link_optional: 'Room 4, Second Floor',
    },
  ],
};

describe('toPublicOpportunity', () => {
  it('removes the owner identity', () => {
    const view = toPublicOpportunity(opportunity) as Record<string, unknown>;

    expect(view).not.toHaveProperty('owner_user_id');
    expect(view).not.toHaveProperty('owner_name');
    expect(view).not.toHaveProperty('owner_email');
  });

  /**
   * The external-delivery consent affirmation (cto/AdaptaLabs#136) is
   * authoring metadata and leaves by the same door as owner identity.
   *
   * Pinned HERE, in the fast jest suite, and not only in the real-Postgres
   * route test: deleting the destructure left the whole backend jest run
   * green, so the gate that actually blocks a careless edit could not see it.
   *
   * All three stored states, because the redaction is about the KEY being
   * absent, not about its value being falsy - a `delete` guarded on
   * truthiness would pass a `true`-only arm and publish every recorded false.
   */
  it('removes the external consent affirmation in all three of its states', () => {
    for (const stored of [true, false, null]) {
      const view = toPublicOpportunity({
        ...opportunity,
        external_consent_confirmed: stored,
      }) as Record<string, unknown>;

      expect(view).not.toHaveProperty('external_consent_confirmed');
      // The owner identity beside it, so a mutation that swaps one redaction
      // for the other cannot satisfy this arm on its own.
      expect(view).not.toHaveProperty('owner_email');
      // And the control: this serialiser is not simply dropping everything.
      expect(view.title).toBe('Checkout flow walkthrough');
    }
  });

  /**
   * The admin dashboard fields. The list route attaches the all-time totals
   * only for an admin caller, but that `if` is not a redaction layer - this
   * serialiser is, so a refactor that hoists the totals batch still cannot
   * send lifetime booking counts to a participant. `auto_closed` is how a
   * study closed, an admin concern.
   *
   * Zero and false included, because the redaction is about the KEY: a strip
   * guarded on truthiness would pass a non-zero arm and publish every 0.
   */
  it.each([
    ['non-zero totals, auto-closed', { total_booked: 3, total_capacity: 7, auto_closed: true }],
    ['zero totals, closed by hand', { total_booked: 0, total_capacity: 0, auto_closed: false }],
  ])('removes the admin progress totals and auto_closed, %s', (_label, adminFields) => {
    const view = toPublicOpportunity({ ...opportunity, ...adminFields }) as Record<string, unknown>;

    expect(view).not.toHaveProperty('total_booked');
    expect(view).not.toHaveProperty('total_capacity');
    expect(view).not.toHaveProperty('auto_closed');
    // THE CONTROL: the owner identity beside them is still stripped, so the
    // new names did not displace the old ones from the destructure.
    expect(view).not.toHaveProperty('owner_user_id');
    expect(view).not.toHaveProperty('owner_name');
    expect(view).not.toHaveProperty('owner_email');
    // And it is not simply dropping everything.
    expect(view.title).toBe('Checkout flow walkthrough');
    expect(view.status).toBe('published');
  });

  it('removes the joining link from every session, not just the first', () => {
    const view = toPublicOpportunity(opportunity) as { sessions: Record<string, unknown>[] };

    expect(view.sessions).toHaveLength(2);
    for (const session of view.sessions) {
      expect(session).not.toHaveProperty('location_or_meet_link_optional');
    }
    // A joining link is close to a credential: anyone holding it can usually
    // walk into the call. Assert on the values too, so a rename of the column
    // cannot quietly turn the check above into a tautology.
    expect(JSON.stringify(view)).not.toContain('meet.google.com');
    expect(JSON.stringify(view)).not.toContain('Room 4');
  });

  it('keeps everything a participant actually needs', () => {
    const view = toPublicOpportunity(opportunity) as Record<string, unknown>;

    expect(view.id).toBe('opp-1');
    expect(view.title).toBe('Checkout flow walkthrough');
    // external_link_optional is the link an external-link study IS, and
    // firsthand_study_id is what OpportunityDetail reads to decide whether the
    // study can be started at all. Stripping either breaks the participant.
    expect(view.external_link_optional).toBe('https://example.com/survey');
    expect(view.firsthand_study_id).toBe('study_abc');

    const sessions = view.sessions as Record<string, unknown>[];
    expect(sessions[0].id).toBe('sess-1');
    expect(sessions[0].capacity).toBe(3);
    expect(sessions[0].start_time).toBe('2026-09-01T10:00:00.000Z');
  });

  it('does not mutate the callers object', () => {
    const input = JSON.parse(JSON.stringify(opportunity));
    toPublicOpportunity(input);

    // The admin branch of every route returns the SAME object this is called
    // with elsewhere in the request, so mutating here would strip the admin
    // view too - and only under whichever ordering happened to run first.
    expect(input.owner_email).toBe('researcher@example.com');
    expect(input.sessions[0].location_or_meet_link_optional).toBe(
      'https://meet.google.com/abc-defg-hij'
    );
  });

  it('copes with an opportunity that carries no sessions', () => {
    const { sessions, ...withoutSessions } = opportunity;
    void sessions;

    const view = toPublicOpportunity(withoutSessions) as Record<string, unknown>;

    expect(view).not.toHaveProperty('owner_email');
    expect(view).not.toHaveProperty('sessions');
  });

  it('passes through an opportunity that simply has no sessions key', () => {
    // A real shape: addMockOpportunity takes `any` and unshifts it verbatim, so
    // a mock-created opportunity can genuinely lack the key.
    const missing = toPublicOpportunity({ ...opportunity, sessions: undefined }) as Record<
      string,
      unknown
    >;
    expect(missing.sessions).toBeUndefined();
    expect(missing).not.toHaveProperty('owner_email');
  });

  it('WITHHOLDS sessions of an unrecognised shape rather than passing them through', () => {
    // The first version of this returned an unknown shape untouched, and a
    // test pinned that as the contract. Wrong way round for a control whose
    // whole job is withholding a credential: if sessions ever arrive as
    // something other than an array - the keyed object the list endpoint
    // builds internally, say - passing it through means every joining link
    // goes out and nothing fails. Fail closed.
    const shaped = toPublicOpportunity({
      ...opportunity,
      sessions: { 'sess-1': { location_or_meet_link_optional: 'https://meet.google.com/xyz' } },
    }) as Record<string, unknown>;

    expect(shaped.sessions).toEqual([]);
    expect(JSON.stringify(shaped)).not.toContain('meet.google.com');

    const nulled = toPublicOpportunity({ ...opportunity, sessions: null }) as Record<
      string,
      unknown
    >;
    expect(nulled.sessions).toEqual([]);
  });

  it('tolerates a null entry inside the sessions array', () => {
    const view = toPublicOpportunity({
      ...opportunity,
      sessions: [null, opportunity.sessions[0]],
    }) as { sessions: unknown[] };

    expect(view.sessions[0]).toBeNull();
    expect(view.sessions[1]).not.toHaveProperty('location_or_meet_link_optional');
  });
});
