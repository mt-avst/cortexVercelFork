// Utility functions for opportunity-related operations

import { Opportunity } from '../api/types';
import { runsNativeSurvey, QUESTION_CARRYING_TYPES } from '@shared/firsthand/delivery';

/**
 * Checks if an opportunity type uses external links (no sessions)
 * @param type - The opportunity type
 * @returns true if the type uses external links
 */
export const isExternalLinkType = (type: string | null | undefined): boolean => {
  if (!type) return false;
  return ['poll', 'survey', 'question', 'unmoderated'].includes(type.toLowerCase());
};

/*
 * `formatOpportunityType` was here. It produced the admin taxonomy - APP
 * TESTING, UNMODERATED, QUESTION - which was one of three names each type
 * carried. Cortex now has one name per type and `getParticipantFacingType`
 * below produces it, for admins and participants alike, so this had no callers
 * left. Deleted rather than kept: a second formatter is exactly how three names
 * happened.
 */

/**
 * Strips a status suffix that the API has been seen concatenating onto a type
 * (e.g. `unmoderatedpublished`). Shared by every type-reading helper in this
 * file - `getTypeBadgeClass`, `getCardHoverColor`, `getParticipantFacingType`,
 * `getStudyTypeGlyph` - so a fix in one place cannot drift from the others.
 * A review gate found that `getTypeBadgeClass` and `getCardHoverColor` had
 * each kept their own inline copy of this loop despite the docblock's claim;
 * they were equivalent by chance, not by construction.
 */
export const baseTypeOf = (type: string | null | undefined): string => {
  if (!type) return '';
  const lowered = type.toLowerCase();
  for (const suffix of ['published', 'draft', 'closed']) {
    if (lowered.endsWith(suffix)) {
      return lowered.slice(0, -suffix.length);
    }
  }
  return lowered;
};

/**
 * Gets the appropriate CSS class for opportunity type badges
 * @param type - The opportunity type string (can be undefined/null)
 * @returns CSS class string
 */
export const getTypeBadgeClass = (type: string | null | undefined): string => {
  switch (baseTypeOf(type)) {
    case 'test':
      return 'lozenge lozenge-usertest';
    case 'interview':
      return 'lozenge lozenge-interview';
    case 'poll':
      return 'lozenge lozenge-poll';
    case 'survey':
      return 'lozenge lozenge-survey';
    case 'question':
      return 'lozenge lozenge-question';
    case 'unmoderated':
      return 'lozenge lozenge-unmoderated';
    default:
      return 'badge bg-secondary';
  }
};

/**
 * Gets the CSS variable for card hover color based on opportunity type
 * Used for dynamic hover border colors that match the lozenge text color
 * @param type - The opportunity type string (can be undefined/null)
 * @returns CSS variable reference string
 */
export const getCardHoverColor = (type: string | null | undefined): string => {
  switch (baseTypeOf(type)) {
    case 'test': return 'var(--lozenge-usertest-text)';
    case 'survey': return 'var(--lozenge-survey-text)';
    case 'poll': return 'var(--lozenge-poll-text)';
    case 'interview': return 'var(--lozenge-interview-text)';
    case 'question': return 'var(--lozenge-question-text)';
    case 'unmoderated': return 'var(--lozenge-unmoderated-text)';
    default: return 'transparent';
  }
};

/**
 * Strips app-testing and obvious automation/smoke studies from the home listing.
 * Enable with `VITE_PRESENTATION_LISTING=true` in .env (local screenshots / demos).
 */
export function filterOpportunitiesForPresentationListing(
  opportunities: Opportunity[]
): Opportunity[] {
  return opportunities.filter((opp) => !isOpportunityExcludedForPresentation(opp));
}

function isOpportunityExcludedForPresentation(opportunity: Opportunity): boolean {
  const rawType = opportunity.type?.toLowerCase() || '';
  const baseType = rawType.replace(/published|draft|closed$/, '');
  if (baseType === 'test') return true;

  const blob = `${opportunity.title}\n${opportunity.purpose_one_liner ?? ''}`.toLowerCase();
  if (
    /\[e2e\]|\(e2e\)|\be2e\b|smoke test|playwright|m6-poll|superadmin-create|test-draft-warnings/i.test(
      blob
    )
  ) {
    return true;
  }
  return false;
}


/**
 * What anyone should be told this is - participant and admin alike.
 *
 * The browse list showed the internal taxonomy - UNMODERATED, APP TESTING,
 * QUESTION - which is the research team's vocabulary, not the vocabulary of the
 * person being asked to give up an hour. "Unmoderated" describes the absence of
 * a researcher, which is a fact about how the study is run rather than anything
 * a participant needs. This is now the ONLY place a type gets a name: the admin
 * formatter that used to sit beside it is gone, and every surface reads here, so
 * a researcher and a participant discussing a study use the same word.
 *
 * `test` and `unmoderated` are a pair and are named as one. They are the same
 * research method - a usability test - differing only in whether a researcher
 * is present, so naming one of them "Usability test" implied the other was not
 * one. "Live" against "Recorded" is the difference itself, in the two words a
 * participant most needs before clicking: is someone waiting for me, and am I
 * about to be recorded.
 *
 * "Recorded" is load-bearing rather than decorative. It is the first and
 * most-repeated part of the recording disclosure that RecordedStudyExpectations
 * completes on the detail page, and it reaches a participant on the browse row,
 * the filter chip and the booking card long before that page does. A name for
 * this type that drops the word is accurate and quietly less honest.
 */
export const getParticipantFacingType = (type: string | null | undefined): string => {
  switch (baseTypeOf(type)) {
    case 'unmoderated': return 'Recorded session';
    case 'test': return 'Live session';
    case 'interview': return 'Interview';
    case 'poll': return 'Quick poll';
    case 'survey': return 'Survey';
    case 'question': return 'One question';
    // Neutral rather than the raw value: an unrecognised type reaching a
    // participant should read as a study, not as a database enum.
    default: return 'Study';
  }
};

/**
 * What to tell a participant about who can take part - or nothing, which is
 * usually the honest answer.
 *
 * The browse row and the study page each decided this separately and disagreed.
 * The row said nothing for `any`, on the grounds that "Open To All" on nearly
 * every row was noise. The page printed "Any" unconditionally, immediately
 * above a panel telling the reader the study needs a Cortex account and will
 * not work for anyone outside the organisation.
 *
 * "Any" is the untrue one. Every route to taking part requires a signed-in
 * Cortex account, and for a recorded study `external` is refused outright when
 * the opportunity is saved. `internal` is no better: everyone holding an
 * account already is internal, so it narrows nothing either.
 *
 * That leaves the two values that genuinely change whether a given person can
 * take part. Nothing server-side enforces either, so this line is the only
 * warning a participant gets - which is exactly why it must not be spent on
 * values that say nothing.
 */
export const getEligibilityNote = (opportunity: {
  participant_type_required?: 'any' | 'internal' | 'external' | 'specific';
  participant_type_specific_details?: string;
}): string | null => {
  switch (opportunity.participant_type_required) {
    case 'external':
      return 'External participants only';
    case 'specific': {
      // A bare "Specific" warns without informing: it tells someone they may be
      // ineligible and gives them no way to find out. The form requires at
      // least ten characters whenever `specific` is chosen, so an empty value
      // here is a legacy row, and silence beats an unanswerable warning.
      const details = opportunity.participant_type_specific_details?.trim();
      return details ? details : null;
    }
    default:
      return null;
  }
};

/**
 * The verb for what taking part involves.
 *
 * This carries the fork that actually governs the choice: three of the six
 * types need you at a booked time, three you can do whenever. That difference
 * was previously encoded nowhere on the card, so a participant scanning for
 * something they could do in a gap between meetings could not find one.
 */
export const getParticipantActionLabel = (type: string | null | undefined): string => {
  switch (baseTypeOf(type)) {
    case 'test':
    case 'interview':
      return 'Book a time';
    case 'poll': return 'Open poll';
    case 'survey': return 'Open survey';
    case 'question': return 'Answer';
    case 'unmoderated': return 'Start recorded session';
    default: return 'Take part';
  }
};

/**
 * What "an action" actually was, for the analytics card that counts them.
 *
 * The card described every study's actions as "Clicked link / Booked". A
 * recorded study has no link to click and nothing to book - its action is the
 * participant pressing Start - so the one figure telling a researcher how many
 * people began their study described something that cannot happen in it.
 *
 * Past tense, because this labels a count of things that already happened;
 * `getParticipantActionLabel` is the imperative a participant is offered.
 */
export const getActionMeaning = (type: string | null | undefined): string => {
  switch (baseTypeOf(type)) {
    case 'test':
    case 'interview':
      return 'Booked a time';
    case 'poll': return 'Opened the poll';
    case 'survey': return 'Opened the survey';
    case 'question': return 'Answered';
    case 'unmoderated': return 'Started the study';
    default: return 'Took part';
  }
};

/**
 * When this stops being available, or null when nothing says.
 *
 * `end_date` is the recruitment window and is authoritative where it is set.
 * A bookable study often carries no end_date at all, and its real deadline is
 * its last slot, so that is the fallback.
 */
export const getClosingTime = (opportunity: Opportunity): Date | null => {
  if (opportunity.end_date) {
    const endDate = new Date(opportunity.end_date);
    // An unparseable date must read as "unknown", never as epoch zero - which
    // would sort a broken record to the top as the most urgent thing on screen.
    if (!isNaN(endDate.getTime())) return endDate;
  }

  const sessionEnds = (opportunity.sessions ?? [])
    .map((session) => new Date(session.end_time).getTime())
    .filter((time) => !isNaN(time));

  if (sessionEnds.length === 0) return null;

  return new Date(Math.max(...sessionEnds));
};

/**
 * Closing soonest first, unknown deadlines last.
 *
 * The list rendered "4 days left" on a card and then placed that card twelfth,
 * so it displayed urgency and sorted against it. Undated studies go last rather
 * than first: an unknown deadline is not an imminent one, and sorting them to
 * the top would bury everything that genuinely is closing.
 *
 * Returns a new array - the caller's order is often the memoised input to
 * something else.
 */
export const sortByClosingSoonest = <T extends Opportunity>(opportunities: T[]): T[] => {
  const now = Date.now();

  // Three tiers, because a plain ascending sort gives an ENDED study the
  // smallest key of all and puts the longest-expired thing on the page at row
  // one. Published studies are auto-closed at their end_date now (Decision 3),
  // but the sweep runs hourly, so within the hour after a study ends it is
  // still published-and-expired - a state a participant genuinely meets on a
  // list that shows only published studies. The ended tier orders that window.
  const tierOf = (closesAt: Date | null): number => {
    if (!closesAt) return 1;             // unknown: after the open ones
    return closesAt.getTime() < now ? 2  // ended: last
      : 0;                               // open: first
  };

  // Equal keys keep their given order because Array.prototype.sort has been
  // REQUIRED to be stable since ES2019. An explicit index tie-break was tried
  // here and removed: it is unobservable through this function at any list
  // length - mutating it to `return 1` changed nothing, even across 80 equal
  // elements - so it was code no test could ever hold to account.
  return [...opportunities].sort((a, b) => {
    const aClose = getClosingTime(a);
    const bClose = getClosingTime(b);

    const tierDiff = tierOf(aClose) - tierOf(bClose);
    if (tierDiff !== 0) return tierDiff;
    if (!aClose || !bClose) return 0;

    // Within the open tier, soonest first. Within the ended tier, most recently
    // ended first - a study that closed yesterday is more relevant than one
    // that closed in the spring.
    return tierOf(aClose) === 2
      ? bClose.getTime() - aClose.getTime()
      : aClose.getTime() - bClose.getTime();
  });
};

/**
 * ROLE/SKILLS MATCHING - browse discovery, advisory only.
 *
 * A study "matches" a viewer when the study's advertised audience
 * (`target_roles`) and the viewer's active role set share at least one entry,
 * compared case-insensitively and after trimming, so "Jira admin" matches
 * "jira admin". This DESCRIBES fit; it never gates - matching changes highlight
 * and sort order only, never visibility, and it is independent of the screener
 * and participant_type gates (a matched study can still screen you out).
 *
 * Both sides use the one shared vocabulary (shared/target-roles.ts), which is
 * what keeps this a plain intersection rather than a fuzzy compare.
 */
export const rolesIntersect = (
  a: readonly string[] | null | undefined,
  b: readonly string[] | null | undefined
): boolean => {
  if (!a || !b || a.length === 0 || b.length === 0) {
    return false;
  }
  const lowerA = new Set(a.map((role) => role.trim().toLowerCase()));
  return b.some((role) => lowerA.has(role.trim().toLowerCase()));
};

/**
 * The role set that drives match highlighting, with the precedence pinned in one
 * place so the transient override can never accidentally persist:
 *
 *   1. the transient "browse as..." override (client state, resets on reload), else
 *   2. the saved profile (`user.profile_roles`), else
 *   3. none - no matching, the browse list still works fully.
 *
 * Kept pure and separate from any PATCH so a test can prove browse-as only feeds
 * matching and never writes.
 */
export const resolveActiveMatchRoles = (
  browseAs: readonly string[] | null | undefined,
  profileRoles: readonly string[] | null | undefined
): string[] => {
  if (browseAs && browseAs.length > 0) {
    return [...browseAs];
  }
  if (profileRoles && profileRoles.length > 0) {
    return [...profileRoles];
  }
  return [];
};

/**
 * Does this study's advertised audience intersect the active role set? A thin
 * wrapper over `rolesIntersect` so the row, the sort and the "For you" partition
 * all ask the question the same way.
 */
export const opportunityMatchesRoles = (
  opportunity: Pick<Opportunity, 'target_roles'>,
  activeRoles: readonly string[]
): boolean => rolesIntersect(opportunity.target_roles, activeRoles);

/**
 * BROWSE FACETS (phase 2) - client-side narrowing of the already-loaded
 * published set. Every axis operates on the loaded studies; there is no new
 * list query. See the cap caveat: valid only while the published count is at or
 * below the list endpoint's cap (mirrored in PUBLISHED_LIST_CAP below).
 */

export type StudyDelivery = 'in_app' | 'external';

/**
 * How a participant reaches the study: inside Cortex, or handed off to a
 * third-party form. Only a question-carrying type (poll/survey/question) set to
 * EXTERNAL delivery hands off; a native survey, a recorded study, a test and an
 * interview all run in-app. Derived from `runsNativeSurvey` so this and the
 * authoring/detail surfaces cannot disagree about what "native" means.
 */
export const getStudyDelivery = (
  opportunity: Pick<Opportunity, 'type' | 'delivery_mode'>
): StudyDelivery => {
  // Strip a status suffix the list API has been seen concatenating onto the type
  // (baseTypeOf's reason for existing), and use the STRIPPED value everywhere -
  // runsNativeSurvey does an exact set membership, so passing the raw type would
  // read `surveypublished` as not-question-carrying and mis-file a native survey.
  const type = baseTypeOf(opportunity.type);
  const isQuestionCarrying = QUESTION_CARRYING_TYPES.has(type);
  return isQuestionCarrying && !runsNativeSurvey(type, opportunity.delivery_mode)
    ? 'external'
    : 'in_app';
};

export const DELIVERY_LABELS: Record<StudyDelivery, string> = {
  in_app: 'In Cortex',
  external: 'External hand-off',
};

export type StudyTimeBucket = 'under_5' | '5_15' | '15_30' | '30_plus' | 'unspecified';

/** The buckets in display order, with their participant-facing labels. */
export const STUDY_TIME_BUCKETS: readonly { key: StudyTimeBucket; label: string }[] = [
  { key: 'under_5', label: 'Under 5 min' },
  { key: '5_15', label: '5-15 min' },
  { key: '15_30', label: '15-30 min' },
  { key: '30_plus', label: '30+ min' },
  { key: 'unspecified', label: 'Not specified' },
];

const TIME_BUCKET_LABEL: Record<StudyTimeBucket, string> = STUDY_TIME_BUCKETS.reduce(
  (acc, b) => ({ ...acc, [b.key]: b.label }),
  {} as Record<StudyTimeBucket, string>
);

export const timeBucketLabel = (bucket: StudyTimeBucket): string => TIME_BUCKET_LABEL[bucket];

const bucketForMinutes = (minutes: number): StudyTimeBucket =>
  minutes < 5 ? 'under_5' : minutes < 15 ? '5_15' : minutes < 30 ? '15_30' : '30_plus';

/**
 * A coarse time-commitment bucket, DERIVED PER TYPE - never a stored field -
 * mirroring exactly what the detail page tells a participant taking part:
 *
 *  - test / interview: `default_duration_minutes` (the researcher set it)
 *  - recorded (unmoderated): the estimate lives on the STUDY, not the list
 *    payload, so the browse list has no figure and reads "Not specified"; when a
 *    caller does have the estimate (the detail page) it is passed and bucketed,
 *    so this stays the one source of truth. `default_duration_minutes` is
 *    NOT NULL DEFAULT 30 and meaningless for this type, so it is never read.
 *  - native survey/poll/question: an honest qualitative expectation - a survey
 *    is "a few minutes", a poll or single question one interaction - both under 5
 *  - external hand-off (and anything unrecognised): Cortex never sees the form,
 *    so no time is claimed - "Not specified"
 */
export const getStudyTimeBucket = (
  opportunity: Pick<Opportunity, 'type' | 'default_duration_minutes' | 'delivery_mode'> & {
    estimated_duration_minutes?: number | null;
  }
): StudyTimeBucket => {
  const type = baseTypeOf(opportunity.type);

  if (type === 'test' || type === 'interview') {
    return bucketForMinutes(opportunity.default_duration_minutes);
  }

  if (type === 'unmoderated') {
    return opportunity.estimated_duration_minutes != null
      ? bucketForMinutes(opportunity.estimated_duration_minutes)
      : 'unspecified';
  }

  // The STRIPPED type, for the same reason as getStudyDelivery above.
  if (runsNativeSurvey(type, opportunity.delivery_mode)) {
    return 'under_5';
  }

  return 'unspecified';
};

/**
 * The active facet selection. An empty axis is NO constraint on that axis;
 * within an axis the values are OR'd; across axes they are AND'd.
 */
export interface StudyFacetSelection {
  roles: string[];
  types: string[];
  deliveries: StudyDelivery[];
  timeBuckets: StudyTimeBucket[];
}

// Frozen so this shared cleared-value singleton cannot have its axes reassigned
// and poisoned for every consumer. The arrays themselves are never mutated in
// place - `toggle` always returns a new array and setFacetSelection replaces the
// whole object - so the object freeze plus that pure-update contract is the
// guarantee (the arrays stay typed mutable because StudyFacetSelection is).
export const EMPTY_FACET_SELECTION: StudyFacetSelection = Object.freeze({
  roles: [],
  types: [],
  deliveries: [],
  timeBuckets: [],
});

export const facetSelectionCount = (selection: StudyFacetSelection): number =>
  selection.roles.length +
  selection.types.length +
  selection.deliveries.length +
  selection.timeBuckets.length;

/**
 * The list endpoint's hard cap on returned published studies
 * (backend `MAX_OPPORTUNITIES_RETURNED`, opportunities.ts), mirrored here as a
 * literal and pinned in a test.
 *
 * Client-side faceting is complete only while the published set is at or below
 * this. Crucially, the list endpoint does NOT silently truncate above it: it
 * queries `LIMIT cap + 1` and returns HTTP 413 when the count exceeds the cap
 * (opportunities.ts). So a rendered list is always the WHOLE published set - a
 * successful response can never be a truncated page - which is why there is no
 * "showing the first N" notice here: it could never correctly fire (exactly-cap
 * is the complete set; over-cap fails the request outright). When the count
 * approaches the cap, faceting moves server-side (phase 3), which will also give
 * the >cap case a real listing instead of a 413. If the backend constant changes,
 * this literal and its pinning test change with it - the coupling is enforced by
 * the test, not the type system (they cannot import across the bundle boundary).
 */
export const PUBLISHED_LIST_CAP = 1000;

export interface FacetOptions {
  roles: string[];
  types: string[];
  deliveries: StudyDelivery[];
  timeBuckets: StudyTimeBucket[];
}

/**
 * The facet options actually PRESENT across the loaded studies, so a participant
 * is never offered a value that matches nothing. Roles keep the viewer's own
 * profile roles first (then the rest, case-insensitively de-duplicated); types,
 * deliveries and time buckets come out in a stable canonical order.
 */
export const deriveFacetOptions = (
  opportunities: readonly Opportunity[],
  profileRoles: readonly string[] = []
): FacetOptions => {
  const roleFirstSpelling = new Map<string, string>();
  const presentTypes = new Set<string>();
  const presentDeliveries = new Set<StudyDelivery>();
  const presentBuckets = new Set<StudyTimeBucket>();

  const addRole = (role: string) => {
    const key = role.trim().toLowerCase();
    if (key && !roleFirstSpelling.has(key)) {
      roleFirstSpelling.set(key, role.trim());
    }
  };

  // Viewer's own profile roles first, but only the ones some study advertises.
  const advertised = new Set<string>();
  for (const opp of opportunities) {
    presentTypes.add(baseTypeOf(opp.type));
    presentDeliveries.add(getStudyDelivery(opp));
    presentBuckets.add(getStudyTimeBucket(opp));
    for (const role of opp.target_roles ?? []) {
      advertised.add(role.trim().toLowerCase());
    }
  }
  for (const role of profileRoles) {
    if (advertised.has(role.trim().toLowerCase())) {
      addRole(role);
    }
  }
  for (const opp of opportunities) {
    for (const role of opp.target_roles ?? []) {
      addRole(role);
    }
  }

  const CANONICAL_TYPES = ['test', 'unmoderated', 'survey', 'poll', 'interview', 'question'];
  return {
    roles: [...roleFirstSpelling.values()],
    types: CANONICAL_TYPES.filter((t) => presentTypes.has(t)),
    deliveries: (['in_app', 'external'] as StudyDelivery[]).filter((d) => presentDeliveries.has(d)),
    timeBuckets: STUDY_TIME_BUCKETS.map((b) => b.key).filter((k) => presentBuckets.has(k)),
  };
};

/** AND across axes, OR within each axis; an empty axis imposes no constraint. */
export const opportunityPassesFacets = (
  opportunity: Pick<Opportunity, 'type' | 'default_duration_minutes' | 'delivery_mode' | 'target_roles'>,
  selection: StudyFacetSelection
): boolean => {
  if (selection.roles.length > 0 && !rolesIntersect(opportunity.target_roles, selection.roles)) {
    return false;
  }
  if (selection.types.length > 0 && !selection.types.includes(baseTypeOf(opportunity.type))) {
    return false;
  }
  if (selection.deliveries.length > 0 && !selection.deliveries.includes(getStudyDelivery(opportunity))) {
    return false;
  }
  if (
    selection.timeBuckets.length > 0 &&
    !selection.timeBuckets.includes(getStudyTimeBucket(opportunity))
  ) {
    return false;
  }
  return true;
};

/**
 * The countdown for a known closing time.
 *
 * Exists so the row can derive its countdown from the SAME value the sort uses.
 * A bookable study can carry both a session end time and an `end_date`; deriving
 * the countdown from each independently would have sorted by one and displayed
 * the other - two different deadlines for one study, which is worse than
 * showing none.
 */
export const getTimeRemainingUntil = (closesAt: Date | null): {
  text: string | null;
  urgency: 'normal' | 'warning' | 'critical' | 'ended';
} => {
  if (!closesAt || isNaN(closesAt.getTime())) {
    return { text: null, urgency: 'normal' };
  }

  const diffMs = closesAt.getTime() - Date.now();
  if (diffMs <= 0) {
    return { text: 'Ended', urgency: 'ended' };
  }

  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffHours < 1) {
    const diffMinutes = Math.floor(diffMs / (1000 * 60));
    return {
      text: diffMinutes <= 1 ? 'Ending soon' : `${diffMinutes} min left`,
      urgency: 'critical'
    };
  }
  if (diffHours < 24) {
    return {
      text: diffHours === 1 ? '1 hour left' : `${diffHours} hours left`,
      urgency: 'critical'
    };
  }
  if (diffDays === 1) return { text: 'Ends tomorrow', urgency: 'warning' };
  if (diffDays < 3) return { text: `${diffDays} days left`, urgency: 'warning' };
  if (diffDays < 7) return { text: `${diffDays} days left`, urgency: 'normal' };
  if (diffDays < 14) return { text: '1 week left', urgency: 'normal' };
  return { text: `${Math.floor(diffDays / 7)} weeks left`, urgency: 'normal' };
};
