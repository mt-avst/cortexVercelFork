import type { FirstHandStudy } from '../api/types';

/** Just enough of the signed-in user to decide who may write a study. */
export type StudyViewer = { id: string; role: string } | null | undefined;

/**
 * Mirrors canWriteStudy in backend/src/firsthand/studies-repository.ts: the
 * owner or a superadmin may write.
 *
 * A study with NO owner is a row created before owners existed. Those stay
 * editable by any admin - the backend claims them on the first real edit - so
 * an absent owner must NOT read as read-only here, or a legacy study would
 * look locked in a UI the API would happily have accepted a save from.
 *
 * This is an affordance, not the gate. The backend answers 403 either way.
 * Lives in utils rather than beside the editor because the studies index needs
 * the same answer to decide between Edit and View.
 */
export function isStudyReadOnly(
  study: Pick<FirstHandStudy, 'owner_user_id'> | undefined,
  viewer: StudyViewer
): boolean {
  if (!study?.owner_user_id) {
    return false;
  }

  return study.owner_user_id !== viewer?.id && viewer?.role !== 'superadmin';
}
