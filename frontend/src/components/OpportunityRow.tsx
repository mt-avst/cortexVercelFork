import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Clock, Timer, Users } from 'lucide-react';

import type { Opportunity, User } from '../api/types';
import {
  getClosingTime,
  getEligibilityNote,
  getParticipantActionLabel,
  getParticipantFacingType,
  getTimeRemainingUntil,
} from '../utils/opportunityUtils';

type OpportunityRowProps = {
  opportunity: Opportunity;
  /** The viewer's role. Only admins ever see a status. */
  role?: User['role'];
};

/**
 * One study, as a row in an index.
 *
 * This replaced a card grid, and the reasons are worth keeping because they
 * were not stylistic:
 *
 * - The grid was three FIXED 352px columns on any viewport, using 44% of a
 *   2560px screen, with `align-items: stretch` locking every row to its tallest
 *   member. A three-word study got a 502px box with 155px of dead white in the
 *   middle, which reads as a card that failed to load. A row sized to its own
 *   content cannot have that problem at all.
 * - Nothing on a card said what taking part involved. Twelve click targets, no
 *   verbs. The action label here carries the fork that actually governs the
 *   choice: whether this needs a slot in your diary or five minutes now.
 * - The badges were the internal taxonomy. "Unmoderated" describes the absence
 *   of a researcher, which is a fact about how a study is run, not something
 *   the person being asked to give up an hour needs to decode.
 *
 * ONE interactive element per row, deliberately. The row is a link and the
 * action reads as a button without being one: a real button nested inside a
 * link is two tab stops and two targets for a single destination.
 */
export function OpportunityRow({ opportunity, role }: OpportunityRowProps) {
  const isAdmin = role === 'researcher_admin' || role === 'superadmin';
  const isBookable = opportunity.type === 'test' || opportunity.type === 'interview';

  // Derived from the SAME value the list sorts on, so a study cannot sort by
  // one deadline and display another.
  const remaining = getTimeRemainingUntil(getClosingTime(opportunity));

  // Read off the countdown rather than recomputed from the timestamp. The
  // earlier version compared a SIGNED difference against three days, so every
  // study that had already ENDED satisfied it and "Ended" was painted in the
  // urgency accent - the loudest thing on the page spent on the one study
  // nobody could take part in.
  const isUrgent = remaining.urgency === 'warning' || remaining.urgency === 'critical';

  // 'any' and 'internal' are dropped deliberately - "Open To All" on nearly
  // every row was noise. 'external' and 'specific' are the two values that
  // change whether a given person can take part at all, and nothing server-side
  // enforces either, so the row is the only warning before the detail page.
  // Shared with the detail page: this reasoning used to live only here, and the
  // detail page reached the opposite conclusion and printed "Any".
  const eligibility = getEligibilityNote(opportunity);

  return (
    <li className="opportunity-row">
      {/* No aria-label. An explicit label REPLACES the link's content as its
          accessible name, so the deadline and the eligibility line - both
          inside this link - were never announced. The name is composed from the
          content instead, which reads: kind, title, purpose, meta, action. */}
      <Link to={`/opportunities/${opportunity.id}`} className="opportunity-row__link">
        <div className="opportunity-row__body">
          <p className="opportunity-row__kind">
            {getParticipantFacingType(opportunity.type)}
            {isAdmin && (
              <span className="opportunity-row__status"> · {opportunity.status}</span>
            )}
          </p>

          {/* h2, not h3: the listing page's only preceding heading is its h1, so
              an h3 here skips a level and axe reports heading-order. Light-mode
              h1-h3 all take the display face and the size comes from the class,
              so this renders identically. */}
          <h2 className="opportunity-row__title">{opportunity.title}</h2>

          {opportunity.purpose_one_liner && (
            <p className="opportunity-row__purpose">{opportunity.purpose_one_liner}</p>
          )}

          {/* A list, not a row of spans: a screen reader otherwise reads
              "45 min4 days leftInternal" as one string. */}
          <ul className="opportunity-row__meta" role="list" data-testid="opportunity-row-meta">
            {/* Duration is authored ONLY for test and interview. Every other
                type falls to the column default of 30, so printing it would
                state a number no researcher chose. */}
            {isBookable && (
              <li className="opportunity-row__meta-item">
                <Clock size={14} aria-hidden="true" />
                {opportunity.default_duration_minutes} min
              </li>
            )}

            {remaining.text && (
              <li
                className={`opportunity-row__meta-item opportunity-row__closing${
                  isUrgent ? ' opportunity-row__closing--urgent' : ''
                }`}
              >
                <Timer size={14} aria-hidden="true" />
                {remaining.text}
              </li>
            )}

            {eligibility && (
              <li className="opportunity-row__meta-item">
                <Users size={14} aria-hidden="true" />
                {eligibility}
              </li>
            )}
          </ul>
        </div>

        {/* Same place on every row, which is the point. Not a button: see the
            note above about nesting one inside a link. NOT aria-hidden either -
            it is the only verb on the row, and hiding it left assistive tech
            with no statement of what taking part involves. */}
        <span className="opportunity-row__action">
          {getParticipantActionLabel(opportunity.type)}
          <ArrowRight size={16} />
        </span>
      </Link>
    </li>
  );
}

export default OpportunityRow;
