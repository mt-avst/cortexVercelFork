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
 * `createSession`'s only change for cto/AdaptaLabs#159 is an additive third
 * argument threaded straight through to `seedRuntimeSession` - the route
 * calls it from inside `runSerializedForMintPair`'s locked transaction and
 * needs the seed to land ON that client, not a fresh one racing the lock.
 * `getStudyById` deliberately does NOT receive it (see session-create.ts's
 * own docblock): it reads `studies`, not `runtime_sessions`, so it carries no
 * part of the race this fix closes and stays on its own pooled read either
 * way.
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
  });

  it('threads a supplied existingClient straight through to seedRuntimeSession, unchanged', async () => {
    const fakeClient = { query: vi.fn(), release: vi.fn() };

    const result = await createSession(
      { studyId: 'study_abc', participant },
      fakeClient as never
    );

    expect(result.ok).toBe(true);
    expect(seedRuntimeSessionMock).toHaveBeenCalledTimes(1);
    // The SAME object, not a copy or a wrapper - seedRuntimeSession has to
    // run its writes on the caller's actual locked transaction.
    expect(seedRuntimeSessionMock.mock.calls[0][1]).toBe(fakeClient);
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
