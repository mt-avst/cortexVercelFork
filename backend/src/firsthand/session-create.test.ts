import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock is hoisted above const declarations, so the mock fns must be created
// inside vi.hoisted() to be referenceable from the factories.
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

import {
  createSession,
  DEFAULT_SESSION_EXPIRES_IN_MINUTES,
  MAX_SESSION_EXPIRES_IN_MINUTES,
} from './session-create';

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

describe('createSession', () => {
  beforeEach(() => {
    isStudiesPersistenceConfiguredMock.mockReturnValue(true);
    getStudyByIdMock.mockResolvedValue(validStudy);
    seedRuntimeSessionMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns persistence_not_configured and never seeds when the runtime DB is unset', async () => {
    isStudiesPersistenceConfiguredMock.mockReturnValue(false);
    const result = await createSession({ studyId: 'study_abc', participant });
    expect(result).toEqual({ ok: false, error: 'persistence_not_configured' });
    expect(seedRuntimeSessionMock).not.toHaveBeenCalled();
  });

  it('returns study_not_found when the study is missing', async () => {
    getStudyByIdMock.mockResolvedValue(null);
    const result = await createSession({ studyId: 'missing', participant });
    expect(result).toEqual({ ok: false, error: 'study_not_found' });
    expect(seedRuntimeSessionMock).not.toHaveBeenCalled();
  });

  it('returns study_has_no_steps when the study has zero steps', async () => {
    getStudyByIdMock.mockResolvedValue({ ...validStudy, steps: [] });
    const result = await createSession({ studyId: 'study_abc', participant });
    expect(result).toEqual({ ok: false, error: 'study_has_no_steps' });
    expect(seedRuntimeSessionMock).not.toHaveBeenCalled();
  });

  it('returns payload_assembly_failed when the assembled payload is invalid', async () => {
    // Duplicate step order violates the contract superRefine.
    getStudyByIdMock.mockResolvedValue({
      ...validStudy,
      steps: [
        { step_id: 'step_001', order: 1, type: 'instruction' as const, prompt: 'A' },
        { step_id: 'step_002', order: 1, type: 'end' as const, prompt: 'B' },
      ],
    });
    const result = await createSession({ studyId: 'study_abc', participant });
    expect(result).toEqual({ ok: false, error: 'payload_assembly_failed' });
    expect(seedRuntimeSessionMock).not.toHaveBeenCalled();
  });

  it('mints a bound session and seeds the runtime on success', async () => {
    const before = Date.now();
    const result = await createSession({
      studyId: 'study_abc',
      participant,
      returnUrl: 'https://cortex.example.com/opportunities/opp-1?completed=1',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');

    // Token scheme matches FirstHand: session_<uuid> + fh_<base64url(24)>.
    expect(result.session.session_id).toMatch(/^session_[0-9a-f-]{36}$/);
    expect(result.session.session_token).toMatch(/^fh_[A-Za-z0-9_-]{32}$/);
    expect(new Date(result.session.expires_at).getTime()).toBeGreaterThan(before);

    expect(seedRuntimeSessionMock).toHaveBeenCalledTimes(1);
    const seeded = seedRuntimeSessionMock.mock.calls[0][0];

    // Binding invariants (decision 7 / H3): participant + session agree, and the
    // session is single-use with the study bound.
    expect(seeded.participant.participant_id).toBe('user-42');
    expect(seeded.session.participant_id).toBe('user-42');
    expect(seeded.session.study_id).toBe('study_abc');
    expect(seeded.session.single_use).toBe(true);
    expect(seeded.session.session_token).toBe(result.session.session_token);
    expect(seeded.session.return_url).toBe(
      'https://cortex.example.com/opportunities/opp-1?completed=1'
    );
    // Internal handoff mints no callback URL — the runtime writes events directly.
    expect(seeded.session.callback_url).toBeUndefined();
  });

  /**
   * The field the runtime's recording guard reads.
   *
   * Every route-level test of that guard builds its own payload, so all of them
   * passed with this stamp deleted - the guard was correct and could never
   * fire, because no minted payload would ever say `survey`. Caught by mutation
   * testing, which is the only thing that could have caught it.
   */
  it('stamps the study kind onto the payload, so the runtime can tell the two apart', async () => {
    getStudyByIdMock.mockResolvedValue({
      ...validStudy,
      study: { ...validStudy.study, kind: 'survey' as const }
    });

    const result = await createSession({ studyId: 'study_abc', participant });
    if (!result.ok) throw new Error('expected success');

    expect(seedRuntimeSessionMock.mock.calls[0][0].study.kind).toBe('survey');
  });

  it('carries a recorded study as recorded rather than dropping the field', async () => {
    getStudyByIdMock.mockResolvedValue({
      ...validStudy,
      study: { ...validStudy.study, kind: 'recorded' as const }
    });

    const result = await createSession({ studyId: 'study_abc', participant });
    if (!result.ok) throw new Error('expected success');

    // Asserted separately from the survey case: a stamp hardcoded to 'survey'
    // would satisfy the test above and refuse every real recording.
    expect(seedRuntimeSessionMock.mock.calls[0][0].study.kind).toBe('recorded');
  });

  /**
   * The snapshot has to carry the classification, not only the wording.
   *
   * The text alone answers "what did this participant agree to". It cannot
   * answer "and was that the wording anybody approved", because both halves of
   * that question move afterwards: the study can be edited, and a template can
   * be superseded. Freezing the pair at mint is what makes the record
   * answerable later, which is the whole reason the columns exist.
   */
  it('snapshots the consent classification beside the wording', async () => {
    getStudyByIdMock.mockResolvedValue({
      ...validStudy,
      study: {
        ...validStudy.study,
        consent_text: 'Bespoke wording for this study',
        consent_template_id: 'custom',
        consent_template_version: null
      }
    });

    const result = await createSession({ studyId: 'study_abc', participant });
    if (!result.ok) throw new Error('expected success');

    const study = seedRuntimeSessionMock.mock.calls[0][0].study;
    expect(study.consent_text).toBe('Bespoke wording for this study');
    expect(study.consent_template_id).toBe('custom');
    expect(study.consent_template_version).toBeNull();
  });

  it('snapshots an approved template with its version, not just its name', async () => {
    getStudyByIdMock.mockResolvedValue({
      ...validStudy,
      study: {
        ...validStudy.study,
        consent_template_id: 'recorded-default',
        consent_template_version: 1
      }
    });

    const result = await createSession({ studyId: 'study_abc', participant });
    if (!result.ok) throw new Error('expected success');

    const study = seedRuntimeSessionMock.mock.calls[0][0].study;
    // Both, and asserted as a pair: an id with no version names wording that
    // cannot be looked up once a second version exists, which is the same as
    // recording nothing.
    expect(study.consent_template_id).toBe('recorded-default');
    expect(study.consent_template_version).toBe(1);
  });

  /**
   * A payload minted before these fields existed is already stored as JSONB and
   * is re-parsed on every read, so the contract has to keep accepting one
   * without them. `kind` records the same argument; this proves it holds for
   * the pair added here rather than assuming it transfers.
   */
  it('still assembles a valid payload for a study with no classification at all', async () => {
    getStudyByIdMock.mockResolvedValue(validStudy);

    const result = await createSession({ studyId: 'study_abc', participant });

    expect(result.ok).toBe(true);
    const study = seedRuntimeSessionMock.mock.calls[0][0].study;
    expect(study.consent_template_id).toBeUndefined();
  });

  it('mints unique tokens across calls', async () => {
    const a = await createSession({ studyId: 'study_abc', participant });
    const b = await createSession({ studyId: 'study_abc', participant });
    if (!a.ok || !b.ok) throw new Error('expected success');
    expect(a.session.session_token).not.toBe(b.session.session_token);
    expect(a.session.session_id).not.toBe(b.session.session_id);
  });

  it('defaults the expiry to 24h when unspecified', async () => {
    const before = Date.now();
    const result = await createSession({ studyId: 'study_abc', participant });
    if (!result.ok) throw new Error('expected success');
    const ttlMinutes = (new Date(result.session.expires_at).getTime() - before) / 60000;
    expect(ttlMinutes).toBeGreaterThan(DEFAULT_SESSION_EXPIRES_IN_MINUTES - 1);
    expect(ttlMinutes).toBeLessThan(DEFAULT_SESSION_EXPIRES_IN_MINUTES + 1);
  });

  it('clamps an over-long requested expiry to the 14-day maximum', async () => {
    const before = Date.now();
    const result = await createSession({
      studyId: 'study_abc',
      participant,
      expiresInMinutes: MAX_SESSION_EXPIRES_IN_MINUTES * 10,
    });
    if (!result.ok) throw new Error('expected success');
    const ttlMinutes = (new Date(result.session.expires_at).getTime() - before) / 60000;
    expect(ttlMinutes).toBeLessThanOrEqual(MAX_SESSION_EXPIRES_IN_MINUTES + 1);
    expect(ttlMinutes).toBeGreaterThan(MAX_SESSION_EXPIRES_IN_MINUTES - 1);
  });
});

/**
 * Which opportunity a session was started from.
 *
 * This is the authorisation key for reading a study's answers per opportunity,
 * so it has to be set by the server from the route it was called on, and it has
 * to survive into storage. It travels in the payload rather than by a follow-up
 * UPDATE because the payload is the only channel the seed and the re-seed on
 * GET /:token/runtime both read, and because sessionSchema strips unknown keys -
 * a field carried outside it would be silently discarded, which is the exact
 * failure that lost every survey answer before 7.36.2.
 */
describe('createSession - opportunity attribution', () => {
  beforeEach(() => {
    isStudiesPersistenceConfiguredMock.mockReturnValue(true);
    getStudyByIdMock.mockResolvedValue(validStudy);
    seedRuntimeSessionMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('carries the opportunity id into the seeded payload', async () => {
    await createSession({
      studyId: 'study_abc',
      participant,
      opportunityId: 'opp-77',
    });

    const seeded = seedRuntimeSessionMock.mock.calls[0][0];
    expect(seeded.session.opportunity_id).toBe('opp-77');
  });

  it('survives contract validation, so it is not stripped before storage', async () => {
    const result = await createSession({
      studyId: 'study_abc',
      participant,
      opportunityId: 'opp-77',
    });

    // The payload seeded is the VALIDATED one, so a field the schema does not
    // know about would be gone by the time it reaches storage while every
    // assertion on the input object still passed.
    expect(result.ok).toBe(true);
    expect(seedRuntimeSessionMock.mock.calls[0][0].session).toHaveProperty(
      'opportunity_id',
      'opp-77'
    );
  });

  it('omits it entirely when the session did not come from an opportunity', async () => {
    await createSession({ studyId: 'study_abc', participant });

    expect(seedRuntimeSessionMock.mock.calls[0][0].session).not.toHaveProperty(
      'opportunity_id'
    );
  });
});
