/**
 * ONE SENTENCE AND ONE CODE FOR "THIS STUDY HAS CLOSED", wherever a participant
 * meets it (cto/AdaptaLabs#129, extended to the booking path by
 * cto/AdaptaLabs#143).
 *
 * Originally local to the two participant-mint routes in `routes/opportunities.ts`.
 * The booking and reschedule routes in `routes/bookings.ts` answered the SAME
 * question - may this participant act on this opportunity right now - with no
 * `end_date` check at all, so a study the mint routes refused as closed could
 * still be booked or rescheduled onto, and would have answered a DIFFERENT
 * sentence and code had it checked anything. Pulled out here so every caller
 * throws the identical refusal rather than keeping its own copy to drift.
 */
export const OPPORTUNITY_CLOSED_CODE = 'OPPORTUNITY_CLOSED';
export const OPPORTUNITY_CLOSED_MESSAGE =
  'This study has closed and is no longer accepting participants.';

/**
 * Has this opportunity's `end_date` already passed?
 *
 * `<=`, not `<` - deliberately matching the mint gate's `has_closed` comparison
 * (cto/AdaptaLabs#129), which itself matches `getTimeRemainingUntil` calling a
 * zero remainder 'ended'. The hourly auto-close sweep
 * (`autoClosePublishedStudiesPastEndDate`) uses `<` instead; the two disagree
 * only on the single instant of exact equality, which resolves the same way one
 * tick later either way.
 *
 * `now` is an explicit parameter, not `new Date()` read inside, so the `<=`
 * boundary is a pinnable unit-test case rather than one no fixture could ever
 * hit against a live clock.
 *
 * A `null` end date means no stated deadline - never closed by this check
 * alone (an undated study is still bounded by the neighbouring `end_time`
 * guard on its slots, which the booking routes already had before #143).
 */
export function hasOpportunityClosed(
  endDate: Date | string | null,
  now: Date = new Date()
): boolean {
  if (endDate === null) {
    return false;
  }
  return new Date(endDate) <= now;
}
