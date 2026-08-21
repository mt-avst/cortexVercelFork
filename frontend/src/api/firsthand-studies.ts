import api from './client';
import type { FirstHandStudy } from './types';
import type { StudyStep } from '../shared/firsthand/contract';
import type { CreateStudyRequest, UpdateStudyRequest } from '../shared/firsthand/study-input';

/**
 * Study ids are client-supplied on create (`createStudyRequestSchema` accepts an
 * optional `id`) and constrained only by `z.string().min(1)`, so an id can hold
 * `/`, `..`, `?` or `#`. Interpolating one raw would let a stored id steer a
 * credentialed, CSRF-token-bearing request at a different same-origin API path,
 * so every id going into a path segment is encoded.
 */

/**
 * Study authoring CRUD against the in-process studies routes
 * (`/api/firsthand/studies*`, all `requireAdmin`). Reuses the shared `api`
 * axios instance from `client.ts`, so the CSRF interceptor (attach + once-on-403
 * refresh) and the 401 handling apply here too.
 */

/** A study plus its ordered steps, as returned by the studies CRUD routes. */
export interface FirstHandStudyWithSteps {
  study: FirstHandStudy;
  steps: StudyStep[];
  /**
   * Whether the reader may edit this study, as decided by the API's own
   * `canWriteStudy` - not re-derived here from `owner_user_id`, which would put
   * a second copy of the rule in the client and get the unowned-legacy case
   * wrong the first time that rule changes.
   *
   * Only GET sends it. Optional so the create and update responses, which do
   * not, still satisfy this type; a caller that needs it must treat its absence
   * as "not stated" rather than as false, or a successful save would flip its
   * own surface to read-only.
   */
  can_edit?: boolean;
  /**
   * How many answers each question has collected, keyed by its step key -
   * which is the same value the authoring form carries as `_clientId` on a
   * question card.
   *
   * A question absent from the map has no answers; there is no row to count.
   *
   * `null` means the count could not be READ, which is a third state and not a
   * synonym for the empty map. The empty map is a known "nothing has been
   * answered"; null is "the runtime database did not answer". A caller that
   * collapses them tells an author a question is safe to remove at exactly the
   * moment the database is under the pressure that suggests participants are
   * answering it.
   *
   * Only GET sends it, like `can_edit` - so undefined means "not stated" and
   * must not be read as "no answers" either.
   */
  answer_counts?: Record<string, number> | null;
}

export const getFirstHandStudy = async (
  studyId: string
): Promise<FirstHandStudyWithSteps> => {
  const response = await api.get(`/firsthand/studies/${encodeURIComponent(studyId)}`);
  return response.data;
};

export const createFirstHandStudy = async (
  payload: CreateStudyRequest
): Promise<FirstHandStudyWithSteps> => {
  const response = await api.post('/firsthand/studies', payload);
  return response.data;
};

export const updateFirstHandStudy = async (
  studyId: string,
  payload: UpdateStudyRequest
): Promise<FirstHandStudyWithSteps> => {
  const response = await api.put(`/firsthand/studies/${encodeURIComponent(studyId)}`, payload);
  return response.data;
};

export const deleteFirstHandStudy = async (studyId: string): Promise<void> => {
  await api.delete(`/firsthand/studies/${encodeURIComponent(studyId)}`);
};

/**
 * Whether a failed request was refused by a rate limiter rather than lost.
 *
 * The difference matters to what the author is told to do next. Every other
 * read failure here is worth retrying immediately - a dropped connection, a
 * 500 - and a 429 is the one that is guaranteed to fail again if they do.
 * Telling them to "try again" is then advice that wastes their time and spends
 * another request against the bucket that refused them.
 */
export const wasRateLimited = (error: unknown): boolean =>
  (error as { response?: { status?: number } })?.response?.status === 429;
