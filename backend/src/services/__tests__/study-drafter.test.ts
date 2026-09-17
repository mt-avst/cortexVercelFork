import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

/**
 * The Anthropic SDK is mocked at the module boundary for every test in this
 * file - no test here may reach the real API. `messages.parse` is the single
 * seam: the service calls nothing else on the client.
 */
jest.mock('@anthropic-ai/sdk', () => {
  const parse = jest.fn();
  const MockAnthropic = jest.fn().mockImplementation(() => ({
    messages: { parse }
  }));
  (MockAnthropic as unknown as { __mockParse: jest.Mock }).__mockParse = parse;
  return { __esModule: true, default: MockAnthropic };
});

import Anthropic from '@anthropic-ai/sdk';
import {
  draftOpportunityFromBrief,
  isAiDraftingConfigured,
  DraftUnavailableError,
  DraftRejectedError,
  MAX_MODEL_CALLS,
  __resetAnthropicClientForTests
} from '../study-drafter';
import { currentConsentTemplate } from '../../../../shared/firsthand/consent-templates';

const mockParse = (
  Anthropic as unknown as {
    __mockParse: jest.Mock<(...args: unknown[]) => Promise<unknown>>;
  }
).__mockParse;

const ORIGINAL_ENV = { ...process.env };

const BRIEF =
  'Do first-time admins understand the new board view well enough to set one up without help?';

/** A minimal, otherwise-valid model output for one type, defaulting to external delivery. */
const modelOutputFor = (
  type: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
  type,
  title: 'Board view discoverability',
  purpose_one_liner: 'Understand whether admins can self-serve the new board view',
  assumptions: [],
  gaps: [],
  ...extra
});

/** A fake Anthropic Message response carrying a successful structured parse. */
const parsedResponse = (parsed_output: unknown, overrides: Record<string, unknown> = {}) => ({
  stop_reason: 'end_turn',
  parsed_output,
  content: [{ type: 'text', text: JSON.stringify(parsed_output) }],
  usage: { output_tokens: 500, cache_read_input_tokens: 0 },
  ...overrides
});

beforeEach(() => {
  process.env.CORTEX_AI_DRAFTING = 'true';
  process.env.ANTHROPIC_API_KEY = 'test-key';
  delete process.env.CORTEX_AI_DRAFTING_MODEL;
  mockParse.mockReset();
  __resetAnthropicClientForTests();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('isAiDraftingConfigured', () => {
  it('is false with the flag on but no key', () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(isAiDraftingConfigured()).toBe(false);
  });

  it('is false with a key but the flag off (kill switch independent of the key)', () => {
    delete process.env.CORTEX_AI_DRAFTING;
    expect(isAiDraftingConfigured()).toBe(false);
  });

  it('is false with the flag set to a truthy-looking non-"true" string', () => {
    process.env.CORTEX_AI_DRAFTING = '1';
    expect(isAiDraftingConfigured()).toBe(false);
  });

  it('is true only with both the flag on and a key present', () => {
    expect(isAiDraftingConfigured()).toBe(true);
  });
});

describe('draftOpportunityFromBrief - dormancy', () => {
  it('throws DraftUnavailableError and never calls the model when the key is absent', async () => {
    delete process.env.ANTHROPIC_API_KEY;

    await expect(draftOpportunityFromBrief({ brief: BRIEF })).rejects.toBeInstanceOf(
      DraftUnavailableError
    );
    expect(mockParse).not.toHaveBeenCalled();
  });

  it('DraftUnavailableError carries the spec\'s 503 body', async () => {
    delete process.env.ANTHROPIC_API_KEY;

    await expect(draftOpportunityFromBrief({ brief: BRIEF })).rejects.toMatchObject({
      statusCode: 503,
      message: 'drafting_unavailable'
    });
  });
});

describe('draftOpportunityFromBrief - each type resolves to itself', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['interview', {}],
    ['test', {}],
    [
      'unmoderated',
      {
        inline_study: {
          steps: [{ type: 'instruction', prompt: 'Open the app and find the board view.' }]
        }
      }
    ],
    ['poll', {}],
    ['question', {}],
    ['survey', {}]
  ];

  it.each(cases)('a %s brief resolves to type %s', async (type, extra) => {
    mockParse.mockResolvedValueOnce(parsedResponse(modelOutputFor(type, extra)));

    const result = await draftOpportunityFromBrief({ brief: BRIEF });

    expect(result.draft.type).toBe(type);
    expect(result.draft.status).toBe('draft');
  });
});

describe('draftOpportunityFromBrief - hints override inference', () => {
  it('a hint wins over the model\'s inferred type', async () => {
    mockParse.mockResolvedValueOnce(parsedResponse(modelOutputFor('survey')));

    const result = await draftOpportunityFromBrief({
      brief: BRIEF,
      hints: { type: 'poll' }
    });

    expect(result.draft.type).toBe('poll');
  });

  it('a hint wins over the model\'s inferred delivery mode', async () => {
    mockParse.mockResolvedValueOnce(
      parsedResponse(
        modelOutputFor('survey', {
          delivery_mode: 'external',
          inline_survey: { steps: [{ type: 'open_text', prompt: 'What did you think?' }] }
        })
      )
    );

    const result = await draftOpportunityFromBrief({
      brief: BRIEF,
      hints: { type: 'survey', delivery_mode: 'native' }
    });

    expect(result.draft.delivery_mode).toBe('native');
  });
});

describe('draftOpportunityFromBrief - delivery resolution', () => {
  it('a brief naming an external tool resolves external delivery', async () => {
    mockParse.mockResolvedValueOnce(
      parsedResponse(modelOutputFor('survey', { delivery_mode: 'external' }))
    );

    const result = await draftOpportunityFromBrief({ brief: BRIEF });

    expect(result.draft.delivery_mode).toBe('external');
    expect(result.draft.inline_survey).toBeUndefined();
  });

  it('a brief naming no external tool resolves native delivery with questions attached', async () => {
    mockParse.mockResolvedValueOnce(
      parsedResponse(
        modelOutputFor('survey', {
          delivery_mode: 'native',
          inline_survey: {
            steps: [{ type: 'open_text', prompt: 'What did you think of the new layout?' }]
          }
        })
      )
    );

    const result = await draftOpportunityFromBrief({ brief: BRIEF });

    expect(result.draft.delivery_mode).toBe('native');
    expect(result.draft.inline_survey?.steps).toHaveLength(1);
  });
});

describe('draftOpportunityFromBrief - question drafts contain exactly one step', () => {
  it('a single-step question draft succeeds', async () => {
    mockParse.mockResolvedValueOnce(
      parsedResponse(
        modelOutputFor('question', {
          delivery_mode: 'native',
          inline_survey: { steps: [{ type: 'open_text', prompt: 'One question only.' }] }
        })
      )
    );

    const result = await draftOpportunityFromBrief({ brief: BRIEF });

    expect(result.draft.inline_survey?.steps).toHaveLength(1);
  });

  it('a two-step question draft is refused (and would be retried, then fail)', async () => {
    const twoStepQuestion = modelOutputFor('question', {
      delivery_mode: 'native',
      inline_survey: {
        steps: [
          { type: 'open_text', prompt: 'First question.' },
          { type: 'open_text', prompt: 'Second question.' }
        ]
      }
    });
    mockParse.mockResolvedValueOnce(parsedResponse(twoStepQuestion));
    mockParse.mockResolvedValueOnce(parsedResponse(twoStepQuestion));

    await expect(draftOpportunityFromBrief({ brief: BRIEF })).rejects.toBeInstanceOf(
      DraftRejectedError
    );
    expect(mockParse).toHaveBeenCalledTimes(MAX_MODEL_CALLS);
  });
});

describe('draftOpportunityFromBrief - consent is filled from the template, never the model', () => {
  it('an unmoderated draft carries the recorded template verbatim', async () => {
    mockParse.mockResolvedValueOnce(
      parsedResponse(
        modelOutputFor('unmoderated', {
          inline_study: {
            steps: [{ type: 'instruction', prompt: 'Open the app.' }]
          }
        })
      )
    );

    const result = await draftOpportunityFromBrief({ brief: BRIEF });
    const template = currentConsentTemplate('recorded');

    expect(result.draft.inline_study?.consent_text).toBe(template.text);
    expect(result.draft.inline_study?.consent_template_id).toBe(template.id);
    expect(result.draft.inline_study?.consent_template_version).toBe(template.version);
  });

  it('a moderated (test/interview) draft carries the moderated template at the top level', async () => {
    mockParse.mockResolvedValueOnce(parsedResponse(modelOutputFor('interview')));

    const result = await draftOpportunityFromBrief({ brief: BRIEF });
    const template = currentConsentTemplate('moderated');

    expect(result.draft.consent_text).toBe(template.text);
    expect(result.draft.consent_template_id).toBe(template.id);
    expect(result.draft.consent_template_version).toBe(template.version);
  });

  it('a native survey draft carries the survey template', async () => {
    mockParse.mockResolvedValueOnce(
      parsedResponse(
        modelOutputFor('survey', {
          delivery_mode: 'native',
          inline_survey: { steps: [{ type: 'open_text', prompt: 'Tell us more.' }] }
        })
      )
    );

    const result = await draftOpportunityFromBrief({ brief: BRIEF });
    const template = currentConsentTemplate('survey');

    expect(result.draft.inline_survey?.consent_text).toBe(template.text);
    expect(result.draft.inline_survey?.consent_template_id).toBe(template.id);
    expect(result.draft.inline_survey?.consent_template_version).toBe(template.version);
  });

  it('the model has no field to write consent into at all', async () => {
    const output = modelOutputFor('interview');
    mockParse.mockResolvedValueOnce(parsedResponse(output));

    await draftOpportunityFromBrief({ brief: BRIEF });

    // The schema sent to the model is what constrains it; assert the actual
    // request carried no consent-shaped property anywhere in its JSON schema.
    const requestArg = mockParse.mock.calls[0][0] as { output_config: { format: unknown } };
    const schemaText = JSON.stringify(requestArg.output_config.format);
    expect(schemaText).not.toMatch(/consent/i);
  });
});

describe('draftOpportunityFromBrief - status is always forced to draft', () => {
  it('stays draft even if a compromised output somehow carried a status field', async () => {
    const output = modelOutputFor('interview');
    // Simulate a value that got past the model schema by some other route -
    // the assembly step must ignore it regardless, because it never reads a
    // `status` field off the model output at all.
    (output as Record<string, unknown>).status = 'published';
    mockParse.mockResolvedValueOnce(parsedResponse(output));

    const result = await draftOpportunityFromBrief({ brief: BRIEF });

    expect(result.draft.status).toBe('draft');
  });
});

describe('draftOpportunityFromBrief - links are copied, never composed', () => {
  it('strips a URL the brief does not contain', async () => {
    mockParse.mockResolvedValueOnce(
      parsedResponse(
        modelOutputFor('poll', {
          delivery_mode: 'external',
          external_link_optional: 'https://forms.example.com/not-in-brief'
        })
      )
    );

    const result = await draftOpportunityFromBrief({ brief: BRIEF });

    expect(result.draft.external_link_optional).toBeUndefined();
  });

  it('keeps a URL the brief actually contains', async () => {
    const url = 'https://forms.example.com/board-view-poll';
    const briefWithLink = `${BRIEF} Use this form: ${url}`;
    mockParse.mockResolvedValueOnce(
      parsedResponse(
        modelOutputFor('poll', {
          delivery_mode: 'external',
          external_link_optional: url
        })
      )
    );

    const result = await draftOpportunityFromBrief({ brief: briefWithLink });

    expect(result.draft.external_link_optional).toBe(url);
  });

  it('strips an unmoderated target_url the brief does not contain', async () => {
    mockParse.mockResolvedValueOnce(
      parsedResponse(
        modelOutputFor('unmoderated', {
          inline_study: {
            target_url: 'https://app.example.com/not-in-brief',
            steps: [{ type: 'instruction', prompt: 'Open the app.' }]
          }
        })
      )
    );

    const result = await draftOpportunityFromBrief({ brief: BRIEF });

    expect(result.draft.inline_study?.target_url).toBeUndefined();
  });
});

describe('draftOpportunityFromBrief - the retry loop', () => {
  it('retries exactly once on an invalid first output, then succeeds', async () => {
    const invalid = modelOutputFor('poll', { title: 'no' }); // fails min(4)... actually too short
    const valid = modelOutputFor('poll');
    mockParse.mockResolvedValueOnce(parsedResponse(invalid));
    mockParse.mockResolvedValueOnce(parsedResponse(valid));

    const result = await draftOpportunityFromBrief({ brief: BRIEF });

    expect(result.draft.type).toBe('poll');
    expect(mockParse).toHaveBeenCalledTimes(2);

    // The retry's messages carry the first assistant turn back, plus a user
    // turn naming what to fix.
    const secondCallArgs = mockParse.mock.calls[1][0] as { messages: Array<{ role: string }> };
    expect(secondCallArgs.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('returns the issues when the second output is also invalid, without a third call', async () => {
    const invalid = modelOutputFor('poll', { title: 'no' });
    mockParse.mockResolvedValueOnce(parsedResponse(invalid));
    mockParse.mockResolvedValueOnce(parsedResponse(invalid));

    await expect(draftOpportunityFromBrief({ brief: BRIEF })).rejects.toMatchObject({
      statusCode: 422
    });
    expect(mockParse).toHaveBeenCalledTimes(MAX_MODEL_CALLS);
  });

  it('MAX_MODEL_CALLS is pinned at 2', () => {
    expect(MAX_MODEL_CALLS).toBe(2);
  });
});

describe('draftOpportunityFromBrief - refusal', () => {
  it('a refusal stop reason surfaces as 422, not 500, with a single call', async () => {
    mockParse.mockResolvedValueOnce(
      parsedResponse(null, { stop_reason: 'refusal' })
    );

    const promise = draftOpportunityFromBrief({ brief: BRIEF });

    await expect(promise).rejects.toBeInstanceOf(DraftRejectedError);
    await expect(promise).rejects.toMatchObject({ statusCode: 422 });
    expect(mockParse).toHaveBeenCalledTimes(1);
  });

  it('a null parsed_output with no refusal also surfaces as 422 rather than throwing unhandled', async () => {
    mockParse.mockResolvedValueOnce(parsedResponse(null, { stop_reason: 'max_tokens' }));

    await expect(draftOpportunityFromBrief({ brief: BRIEF })).rejects.toBeInstanceOf(
      DraftRejectedError
    );
    expect(mockParse).toHaveBeenCalledTimes(1);
  });
});

describe('draftOpportunityFromBrief - model id', () => {
  it('defaults to claude-opus-5', async () => {
    mockParse.mockResolvedValueOnce(parsedResponse(modelOutputFor('poll')));

    await draftOpportunityFromBrief({ brief: BRIEF });

    expect(mockParse.mock.calls[0][0]).toMatchObject({ model: 'claude-opus-5' });
  });

  it('honours CORTEX_AI_DRAFTING_MODEL when set', async () => {
    process.env.CORTEX_AI_DRAFTING_MODEL = 'claude-sonnet-5';
    mockParse.mockResolvedValueOnce(parsedResponse(modelOutputFor('poll')));

    await draftOpportunityFromBrief({ brief: BRIEF });

    expect(mockParse.mock.calls[0][0]).toMatchObject({ model: 'claude-sonnet-5' });
  });
});
