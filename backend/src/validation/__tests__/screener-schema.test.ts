import {
  screenerSchema,
  SCREENER_QUESTION_NEEDS_PASS,
  SCREENER_NEEDS_SCREEN_OUT,
  SCREENER_DUPLICATE_OPTION_ID,
  SCREENER_DUPLICATE_QUESTION_ID,
} from '../../../../shared/screener';

// A question with a distinct pass and a distinct screen-out, so a screener built
// from these is valid on the semantic rules and only the shape under test varies.
const question = (id: string) => ({
  id,
  prompt: `Prompt ${id}`,
  options: [
    { id: `${id}-pass`, label: 'Qualifies', disqualifies: false },
    { id: `${id}-out`, label: 'Screens out', disqualifies: true },
  ],
});

const screenerWith = (questionCount: number) => ({
  questions: Array.from({ length: questionCount }, (_, i) => question(`q${i}`)),
});

const firstError = (input: unknown): string | undefined => {
  const result = screenerSchema.safeParse(input);
  return result.success ? undefined : result.error.issues[0]?.message;
};

describe('screenerSchema', () => {
  it('accepts a minimal valid screener', () => {
    expect(screenerSchema.safeParse(screenerWith(1)).success).toBe(true);
  });

  // Policy caps pinned as LITERALS (SCREENER_MIN/MAX_QUESTIONS = 1/5,
  // SCREENER_MIN/MAX_OPTIONS = 2/6): a test that derived these from the
  // constants could not see the constants change.
  it('holds the question count between 1 and 5', () => {
    expect(screenerSchema.safeParse(screenerWith(0)).success).toBe(false);
    expect(screenerSchema.safeParse(screenerWith(1)).success).toBe(true);
    expect(screenerSchema.safeParse(screenerWith(5)).success).toBe(true);
    expect(screenerSchema.safeParse(screenerWith(6)).success).toBe(false);
  });

  it('holds the option count per question between 2 and 6', () => {
    const withOptions = (n: number) => ({
      questions: [
        {
          id: 'q1',
          prompt: 'Prompt',
          options: Array.from({ length: n }, (_, i) => ({
            id: `o${i}`,
            label: `Option ${i}`,
            // Last option screens out so the pass/screen-out rules are satisfied.
            disqualifies: i === n - 1,
          })),
        },
      ],
    });
    expect(screenerSchema.safeParse(withOptions(1)).success).toBe(false);
    expect(screenerSchema.safeParse(withOptions(2)).success).toBe(true);
    expect(screenerSchema.safeParse(withOptions(6)).success).toBe(true);
    expect(screenerSchema.safeParse(withOptions(7)).success).toBe(false);
  });

  it('rejects a question no answer to which qualifies (nobody could pass it)', () => {
    const noPass = {
      questions: [
        {
          id: 'q1',
          prompt: 'Prompt',
          options: [
            { id: 'o1', label: 'A', disqualifies: true },
            { id: 'o2', label: 'B', disqualifies: true },
          ],
        },
      ],
    };
    expect(firstError(noPass)).toBe(SCREENER_QUESTION_NEEDS_PASS);
  });

  it('rejects a screener with no screen-out answer anywhere (it filters no-one)', () => {
    const noScreenOut = {
      questions: [
        {
          id: 'q1',
          prompt: 'Prompt',
          options: [
            { id: 'o1', label: 'A', disqualifies: false },
            { id: 'o2', label: 'B', disqualifies: false },
          ],
        },
      ],
    };
    expect(firstError(noScreenOut)).toBe(SCREENER_NEEDS_SCREEN_OUT);
  });

  it('rejects duplicate option ids within a question', () => {
    const dupOption = {
      questions: [
        {
          id: 'q1',
          prompt: 'Prompt',
          options: [
            { id: 'same', label: 'A', disqualifies: false },
            { id: 'same', label: 'B', disqualifies: true },
          ],
        },
      ],
    };
    expect(firstError(dupOption)).toBe(SCREENER_DUPLICATE_OPTION_ID);
  });

  it('rejects duplicate question ids', () => {
    const dupQuestion = { questions: [question('dup'), question('dup')] };
    expect(firstError(dupQuestion)).toBe(SCREENER_DUPLICATE_QUESTION_ID);
  });

  it('rejects an empty prompt or an empty option label', () => {
    const emptyPrompt = { questions: [{ ...question('q1'), prompt: '   ' }] };
    const emptyLabel = {
      questions: [
        {
          id: 'q1',
          prompt: 'Prompt',
          options: [
            { id: 'o1', label: '  ', disqualifies: false },
            { id: 'o2', label: 'B', disqualifies: true },
          ],
        },
      ],
    };
    expect(screenerSchema.safeParse(emptyPrompt).success).toBe(false);
    expect(screenerSchema.safeParse(emptyLabel).success).toBe(false);
  });

  it('trims prompts and labels', () => {
    const parsed = screenerSchema.parse({
      questions: [
        {
          id: 'q1',
          prompt: '  Which team?  ',
          options: [
            { id: 'o1', label: '  Engineering  ', disqualifies: false },
            { id: 'o2', label: 'Sales', disqualifies: true },
          ],
        },
      ],
    });
    expect(parsed.questions[0].prompt).toBe('Which team?');
    expect(parsed.questions[0].options[0].label).toBe('Engineering');
  });
});
