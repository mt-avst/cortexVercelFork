import { describe, it, expect, vi, beforeEach } from 'vitest';

// #79 step 1b: bookSession's body construction is a one-liner the page tests
// cannot see (they mock the client module wholesale), and a review gate noted
// that always sending `consent_accepted: true` would pass every frontend
// test. The server gate is what actually refuses - this pins the client's
// half of the contract anyway: the flag travels only as the literal true,
// with the echoed wording beside it, and a consent-free booking sends an
// empty body a pre-consent server would also accept.

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

import { bookSession } from '../client';

beforeEach(() => {
  instance.post.mockReset();
  instance.post.mockResolvedValue({ data: { id: 'b1' } });
});

describe('bookSession body construction', () => {
  it('sends the flag and the echoed wording on acceptance', async () => {
    await bookSession('s1', { consentAccepted: true, consentTextSeen: 'The wording shown.' });

    expect(instance.post).toHaveBeenCalledWith('/bookings/sessions/s1/book', {
      consent_accepted: true,
      consent_text_seen: 'The wording shown.',
    });
  });

  it('sends an empty body with no options - the pre-consent shape', async () => {
    await bookSession('s1');

    expect(instance.post).toHaveBeenCalledWith('/bookings/sessions/s1/book', {});
  });

  it('sends an empty body for consentAccepted: false - false is not a claim', async () => {
    await bookSession('s1', { consentAccepted: false });

    expect(instance.post).toHaveBeenCalledWith('/bookings/sessions/s1/book', {});
  });
});
