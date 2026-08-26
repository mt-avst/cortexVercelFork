import { describe, it, expect, vi, beforeEach } from 'vitest';

// cto/AdaptaLabs#81: getFeedback is the ONE line where the wire shape becomes
// the UI shape, and both review gates on the #81 MR demonstrated it had zero
// coverage - `has_more: true` (and `false`) as a constant survived the whole
// 1512-test frontend suite, because AdminFeedback.test.tsx mocks the client
// module wholesale. These arms make the mapping's strictness a measured claim.

// Hoisted alongside the vi.mock factory, which vitest lifts above imports.
const { instance } = vi.hoisted(() => ({
  instance: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    request: vi.fn(),
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
  },
}));

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => instance),
    get: vi.fn(),
    post: vi.fn(),
  },
}));

import { getFeedback } from '../client';

const row = { id: 'f1', feedback: 'hello' };

beforeEach(() => {
  instance.get.mockReset();
});

describe('getFeedback carries the #81 wire contract into the UI shape', () => {
  it('maps data to items and a true has_more through as true', async () => {
    instance.get.mockResolvedValue({ data: { success: true, data: [row], has_more: true } });

    const result = await getFeedback();

    expect(result.items).toEqual([row]);
    expect(result.has_more).toBe(true);
  });

  it('reads an explicit false as false', async () => {
    instance.get.mockResolvedValue({ data: { success: true, data: [row], has_more: false } });

    expect((await getFeedback()).has_more).toBe(false);
  });

  it('reads a pre-#81 response with no has_more as nothing known to be cut off', async () => {
    // A backend that predates #81 sends no flag at all. `undefined` must not
    // become a truncation notice over a complete list.
    instance.get.mockResolvedValue({ data: { success: true, data: [row] } });

    expect((await getFeedback()).has_more).toBe(false);
  });

  it('refuses a truthy non-boolean, which is what pins the strict equality', async () => {
    // `!!'yes'` is true; `'yes' === true` is not. A flag is a boolean or it
    // is nothing - anything else is a contract drift this arm turns red.
    instance.get.mockResolvedValue({ data: { success: true, data: [row], has_more: 'yes' } });

    expect((await getFeedback()).has_more).toBe(false);
  });
});
