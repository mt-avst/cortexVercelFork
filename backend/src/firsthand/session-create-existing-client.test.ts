import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock is hoisted above const declarations, so the mock fns must be created
// inside vi.hoisted() to be referenceable from the factories - same pattern as
// session-create.test.ts, kept in a separate file so THAT file's mocked
// 'pg'-free assertions never have to reason about a third argument.
const { getStudyByIdMock, isStudiesPersistenceConfiguredMock, seedRuntimeSessionMock } =
  vi.hoisted(() => ({
    getStudyByIdMock: vi.fn(),
    isStudiesPersistenceConfiguredMock: vi.fn(),
    seedRuntimeSessionMock: vi.fn(),
  }));

vi.mock('./studies-repository', () => ({
  getStudyById: getStudyByIdMock,
  isStudiesPersistenceConfigured: isStudiesPersistenceConfiguredMock,
}));

vi.mock('./runtime-repository-postgres', () => ({
  seedRuntimeSession: seedRuntimeSessionMock,
}));

import { createSession } from './session-create';

/**
 * `createSession`'s additive third argument (cto/AdaptaLabs#159) is threaded
 * to BOTH `getStudyById` and `seedRuntimeSession` - the route calls it from
 * inside `runSerializedForMintPair`'s locked transaction and needs both to
 * run ON that client.
 *
 * `seedRuntimeSession`'s reason is race-safety: the seed has to land on the
 * caller's actual locked transaction, not a fresh one racing the lock.
 * `getStudyById`'s reason is connection BUDGET, not a race (MR !528 review
 * pass 1 HIGH-1 corrected an earlier version of this comment that claimed
 * otherwise): it reads `studies`, not `runtime_sessions`, but leaving it on
 * its own pooled read meant every locked mint held TWO runtime-pool
 * connections at once, which exhausted the pool outright at 5+ concurrent
 * participants - see `mint-serializes-concurrent-bursts-postgres.test.ts`'s
 * "survives a burst of MORE participants than the runtime pool has
 * connections" for the real-database proof.
 */
const validStudy = {
  study: {
    id: 'study_abc',
    title: 'Sample study',
    intro_text: 'Open the page and think out loud.',
    consent_text: 'We will record screen and microphone.',
    brand_name: 'Adaptavist',
    estimated_duration_minutes: 12,
    locale: 'en-GB',
    status: 'launched' as const,
    created_at: '2026-06-08T00:00:00.000Z',
    updated_at: '2026-06-08T00:00:00.000Z',
  },
  steps: [
    { step_id: 'step_001', order: 1, type: 'instruction' as const, prompt: 'Open the page' },
    { step_id: 'step_end', order: 2, type: 'end' as const, prompt: 'Thanks' },
  ],
};

const participant = {
  participant_id: 'user-42',
  display_name: 'User 42',
  email: 'user42@example.com',
  external_ref: 'opp-1',
};

describe('createSession - existingClient threading (cto/AdaptaLabs#159)', () => {
  beforeEach(() => {
    isStudiesPersistenceConfiguredMock.mockReturnValue(true);
    getStudyByIdMock.mockResolvedValue(validStudy);
    seedRuntimeSessionMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('omits the third argument by default, so seedRuntimeSession checks out its own connection', async () => {
    const result = await createSession({ studyId: 'study_abc', participant });

    expect(result.ok).toBe(true);
    expect(seedRuntimeSessionMock).toHaveBeenCalledTimes(1);
    expect(seedRuntimeSessionMock.mock.calls[0][1]).toBeUndefined();
    // getStudyById also omits it and behaves exactly as before - the whole
    // point of "additive" (MR !528 review pass 2 LOW-1: this assertion was
    // missing, so a regression here had nothing in this file to catch it).
    expect(getStudyByIdMock.mock.calls[0][1]).toBeUndefined();
  });

  it('threads a supplied existingClient straight through to BOTH getStudyById and seedRuntimeSession, unchanged', async () => {
    const fakeClient = { query: vi.fn(), release: vi.fn() };

    const result = await createSession(
      { studyId: 'study_abc', participant },
      fakeClient as never
    );

    expect(result.ok).toBe(true);
    expect(seedRuntimeSessionMock).toHaveBeenCalledTimes(1);
    // The SAME object, not a copy or a wrapper - both have to run their work
    // on the caller's actual locked transaction, not a fresh checkout racing
    // the lock (getStudyById: MR !528 review pass 1 HIGH-1's fix).
    expect(seedRuntimeSessionMock.mock.calls[0][1]).toBe(fakeClient);
    expect(getStudyByIdMock).toHaveBeenCalledWith('study_abc', fakeClient);
  });

  it('never calls seedRuntimeSession at all on an early refusal, existingClient or not', async () => {
    isStudiesPersistenceConfiguredMock.mockReturnValue(false);
    const fakeClient = { query: vi.fn(), release: vi.fn() };

    const result = await createSession(
      { studyId: 'study_abc', participant },
      fakeClient as never
    );

    expect(result).toEqual({ ok: false, error: 'persistence_not_configured' });
    expect(seedRuntimeSessionMock).not.toHaveBeenCalled();
  });
});
