import { describe, it, expect, vi, beforeEach } from 'vitest';

// The studies CRUD file's own pattern: mock the shared axios instance rather
// than real HTTP. Mirrors firsthand-studies.ts's own `import api from './client'`.
vi.mock('../client', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
}));

import api from '../client';
import { getFirstHandStudyUsage } from '../firsthand-studies';

const mockedGet = vi.mocked(api.get);

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * D4/row 12: which opportunities currently use a task list, backing both the
 * library's detail page and the wizard's "used by N studies" notice.
 */
describe('getFirstHandStudyUsage', () => {
  it('GETs the usage endpoint for the study, url-encoding the id', async () => {
    mockedGet.mockResolvedValue({
      data: { count: 2, studies: [{ id: 'opp_1', title: 'A study', status: 'published' }] },
    });

    const result = await getFirstHandStudyUsage('study one/weird');

    expect(mockedGet).toHaveBeenCalledWith('/firsthand/studies/study%20one%2Fweird/usage');
    expect(result).toEqual({
      count: 2,
      studies: [{ id: 'opp_1', title: 'A study', status: 'published' }],
    });
  });

  it('returns a zero count for a task list nothing uses', async () => {
    mockedGet.mockResolvedValue({ data: { count: 0, studies: [] } });

    const result = await getFirstHandStudyUsage('study_lonely');

    expect(result).toEqual({ count: 0, studies: [] });
  });
});
