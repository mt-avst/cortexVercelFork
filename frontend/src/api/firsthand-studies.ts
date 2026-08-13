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
