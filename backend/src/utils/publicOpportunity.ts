import { redactScreenerForParticipant } from '../../../shared/screener';
import type { Screener } from '../../../shared/types';
import { logger } from './logger';

// The non-admin view of an opportunity and of its sessions.
//
// THREE routes are optionalAuth, so anonymous participants reach them by design
// and every non-admin response from them must pass through here:
// GET /api/opportunities, GET /api/opportunities/:id, and
// GET /api/opportunities/:id/sessions. That third one is easy to miss - it
// returns bare session rows rather than an opportunity, which is why
// toPublicSession is exported separately. If you add a fourth, it comes
// through here too.
//
// TEN fields are stripped outright. NINE of them are
// stripped by the destructure in toPublicOpportunity below: owner_user_id,
// owner_name, owner_email (OWNER IDENTITY, below),
// external_consent_confirmed, published_at, and total_booked /
// total_capacity / auto_closed / responses_total (the admin dashboard
// fields; responses_total per cto/AdaptaLabs#162). The tenth,
// location_or_meet_link_optional (THE SESSION JOINING LINK, below), is session-level rather than opportunity-level, so it is stripped
// separately, by toPublicSession. The screener is NOT on this list: it is
// REDACTED, not stripped - see toParticipantScreenerField.
//
// Those with the sharpest reasoning are documented in their own paragraphs
// below rather than inline:
//
// OWNER IDENTITY (owner_user_id plus the joined owner_name / owner_email) is an
// admin-surface concern: the participant landing page never renders it, so the
// owner's identity must not leave the API.
//
// THE SESSION JOINING LINK (location_or_meet_link_optional) is closer to a
// credential than to a detail. The routes select `s.*`, so it was going out to
// anyone who could name a published opportunity id - no login at all - and a
// Zoom or Meet link is usually the whole of what you need to walk into the
// call. Nothing was reading it: the only frontend consumers are
// AdminSessionManager and OpportunityForm, both admin-side, and both of
// them receive the unstripped admin payload. Someone who has actually
// BOOKED still gets it, from GET /api/bookings/my/bookings (requireAuth, scoped
// to b.user_id) and from the calendar invite the booking sends.
//
// KNOWN BLUNTNESS, recorded rather than guessed at: that column does two jobs.
// It holds a Meet or Zoom URL for a remote session and a room number for an
// in-person one, and the credential argument above applies only to the first.
// Stripping both costs nothing today, because no participant-facing view reads
// this payload's copy at all - MyBookings renders the `session_location` alias
// from the bookings route instead. If in-person wayfinding before booking ever
// matters, strip only when the value parses as a URL.
//
// Deliberately NOT stripped, all load-bearing for participants:
//   - external_link_optional, which is the link an external-link study is FOR
//   - firsthand_study_id, which OpportunityDetail reads to decide whether the
//     study is startable at all. Removing it silently breaks the unmoderated
//     participant flow, and it is an opaque id rather than a secret.
//   - consent_text and its template pair (#79): a VERDICT, not an oversight.
//     A participant must be able to read a moderated opportunity's consent
//     wording BEFORE booking - it is what they are deciding about - so the
//     text is participant-facing by construction, and the template id/version
//     are non-secret provenance metadata. This deny-list publishes new columns
//     by default; these three are the first added since that property was
//     documented, and they pass deliberately. Pinned by a test in
//     opportunities.moderated-consent.test.ts.
//
// EXTERNAL_CONSENT_CONFIRMED (cto/AdaptaLabs#136) is stripped for the same
// reason as owner identity: it is authoring metadata - who confirmed the
// external tool's own consent handling - not a fact the participant page
// renders or needs. Unlike the screener it has no partial shape to preserve,
// so it is a plain destructure below rather than a redaction function.
//
// PUBLISHED_AT (cto/AdaptaLabs#168) is stripped for a narrower reason than
// the others: it is not sensitive on its own, but
// GET /api/opportunities and GET /api/opportunities/:id select `o.*` and
// serve non-admins with `optionalAuth` - no login at all - so it would reach
// an anonymous caller. The "New since your last visit" feature it supports
// is driven entirely by POST /api/participate/visit's own response
// (`newOpportunityIds`), which is authenticated and scoped to the caller;
// nothing participant-facing reads this column directly. Admins keep it (the
// studies table and the create/PATCH responses bypass this serialiser
// entirely, per the isAdmin branches at each call site).

/**
 * What this serialiser can accept.
 *
 * Named for the job rather than for the owner fields, and deliberately NOT
 * used as `Omit<T, keyof PublicSerialisable>`: tying the return type to this
 * interface's keys would silently drop `sessions` from every participant
 * payload the moment the constraint widens to include it. The return type
 * (`PublicView<T>` below) is decoupled for exactly that reason.
 */
interface PublicSerialisable {
  owner_user_id?: unknown;
  owner_name?: unknown;
  owner_email?: unknown;
  sessions?: unknown;
  screener?: unknown;
  external_consent_confirmed?: unknown;
  total_booked?: unknown;
  total_capacity?: unknown;
  auto_closed?: unknown;
  published_at?: unknown;
  responses_total?: unknown;
}

/**
 * The screener's `disqualifies` flags are owner-only: a participant who could
 * see which answer screens them out could game it. This reduces a screener to
 * its participant-facing shape, and FAILS CLOSED - anything that is not a
 * recognisable screener with questions is withheld entirely rather than passed
 * through raw, for the same reason the joining link is (a leak here is silent).
 * `null`/`undefined` (no screener) passes through unchanged.
 */
function toParticipantScreenerField(screener: unknown): unknown {
  if (screener === null || screener === undefined) {
    return screener;
  }
  try {
    const questions = (screener as { questions?: unknown }).questions;
    if (!Array.isArray(questions) || questions.length === 0) {
      return undefined;
    }
    return redactScreenerForParticipant(screener as Screener);
  } catch (error) {
    logger.error('Unexpected screener shape in the public serialiser, withholding it', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

interface JoiningLinkField {
  location_or_meet_link_optional?: unknown;
}

type PublicSession<S> = S extends object ? Omit<S, 'location_or_meet_link_optional'> : S;

/**
 * The type has to say the link is gone, or the compiler is the one thing that
 * could catch the mistake and it has been silenced. Without the mapped sessions
 * type, someone adding a participant-facing location display copies the admin
 * idiom (`session.location_or_meet_link_optional.length > 30`), compiles green
 * and throws `Cannot read properties of undefined` in the participant browser.
 */
type PublicView<T> = Omit<
  T,
  | 'owner_user_id'
  | 'owner_name'
  | 'owner_email'
  | 'external_consent_confirmed'
  | 'total_booked'
  | 'total_capacity'
  | 'auto_closed'
  | 'published_at'
  | 'responses_total'
> &
  (T extends { sessions: infer S extends readonly unknown[] }
    ? { sessions: { [K in keyof S]: PublicSession<S[K]> } }
    : unknown);

/**
 * Strips one session row. Exported because GET /:id/sessions returns session
 * rows directly, without an opportunity wrapped around them.
 *
 * Omit-by-destructuring, with the discarded binding underscore-prefixed per the
 * repo convention - the same rule that surfaced this whole class of bug flags
 * it otherwise.
 */
export function toPublicSession<S>(session: S): PublicSession<S> {
  if (!session || typeof session !== 'object') {
    return session as PublicSession<S>;
  }
  const { location_or_meet_link_optional: _joiningLink, ...publicSession } =
    session as JoiningLinkField & Record<string, unknown>;
  return publicSession as PublicSession<S>;
}

export function toPublicOpportunity<T extends PublicSerialisable>(opportunity: T): PublicView<T> {
  const {
    owner_user_id: _ownerUserId,
    owner_name: _ownerName,
    owner_email: _ownerEmail,
    external_consent_confirmed: _externalConsentConfirmed,
    // Admin dashboard fields. The list route only attaches the totals for an
    // admin caller, but that one `if` is not a redaction layer - this is, so a
    // refactor that hoists the batch cannot send lifetime booking counts to
    // participants. `auto_closed` is how a study closed, an admin concern; on
    // anything a participant can list it is always false, so it says nothing
    // useful and nothing sensitive, and is dropped rather than pinned.
    total_booked: _totalBooked,
    total_capacity: _totalCapacity,
    auto_closed: _autoClosed,
    // "New since your last visit" (cto/AdaptaLabs#168). See the module
    // comment above.
    published_at: _publishedAt,
    // All-time response count for a native poll/survey/question row
    // (cto/AdaptaLabs#162), same reasoning as total_booked/total_capacity
    // above: the list route only attaches it for an admin caller, and this is
    // the redaction layer, not that `if`.
    responses_total: _responsesTotal,
    ...publicView
  } = opportunity;

  // Redact the screener's owner-only disqualifies flags. Applied here, before
  // the sessions branching below, so BOTH return paths are covered.
  if ('screener' in publicView) {
    (publicView as Record<string, unknown>).screener = toParticipantScreenerField(
      (publicView as Record<string, unknown>).screener
    );
  }

  // Absent sessions is a real shape: addMockOpportunity takes `any` and unshifts
  // it verbatim, so a mock-created opportunity can genuinely lack the key.
  if (publicView.sessions === undefined) {
    return publicView as PublicView<T>;
  }

  // Anything else unrecognised FAILS CLOSED. This is a control whose job is
  // withholding a credential, so passing an unknown shape through untouched
  // would mean every link goes out and no test fails.
  if (!Array.isArray(publicView.sessions)) {
    logger.error('Unexpected sessions shape in the public serialiser, withholding them', {
      sessionsType: typeof publicView.sessions,
    });
    return { ...publicView, sessions: [] } as PublicView<T>;
  }

  return {
    ...publicView,
    sessions: publicView.sessions.map(toPublicSession),
  } as PublicView<T>;
}
