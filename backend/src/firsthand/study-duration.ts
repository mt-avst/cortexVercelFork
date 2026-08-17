import { INLINE_STUDY_LIMITS } from "../../../shared/firsthand/inline-study";

/**
 * How long a recorded study takes, or null when nobody said.
 *
 * Unmoderated studies had no duration field in the authoring form, so the
 * create and update paths fell back to the opportunity's
 * `default_duration_minutes` - a NOT NULL column whose DEFAULT is 30. Every
 * recorded study consequently claimed "30 minutes", a figure no researcher had
 * chosen, and it was shown to a participant immediately above a consent button.
 * The figure ended up suppressed in three separate surfaces, because
 * suppressing an invented number is the only honest thing to do with one.
 *
 * `firsthand.studies.estimated_duration_minutes` is nullable with no default,
 * so null already means "not stated" and needs no migration to start meaning
 * it. Every surface that shows a duration already handles null by saying
 * nothing, so an unanswered field costs a participant nothing while a wrong
 * answer costs them their consent being informed.
 */
export function resolveStudyDuration(
  authored: number | null | undefined
): number | null {
  if (authored === null || authored === undefined) return null;
  if (!Number.isFinite(authored)) return null;

  const minutes = Math.round(authored);
  if (minutes <= 0) return null;
  if (minutes > INLINE_STUDY_LIMITS.maxDurationMinutes) return null;

  return minutes;
}
