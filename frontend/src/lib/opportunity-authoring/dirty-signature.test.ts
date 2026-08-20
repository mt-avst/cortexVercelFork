import { describe, expect, it } from 'vitest';
import { dirtySignature, hasUnsavedChanges } from './dirty-signature';

const blank = () => ({
  title: '',
  inline_survey_questions: [] as Array<Record<string, unknown>>,
  inline_study_steps: [] as Array<Record<string, unknown>>
});

describe('dirtySignature', () => {
  it('ignores the client ids minted per hydration', () => {
    // Two arrays that differ ONLY in `_clientId`. Left in, they would report
    // unsaved work on a form nobody had touched.
    expect(
      dirtySignature({
        ...blank(),
        inline_study_steps: [{ _clientId: 'a1', prompt: 'Find the export button' }]
      })
    ).toBe(
      dirtySignature({
        ...blank(),
        inline_study_steps: [{ _clientId: 'b2', prompt: 'Find the export button' }]
      })
    );
  });

  it('ignores them on the questions side too, not only on the task side', () => {
    // The twin. Stripping only one of the two arrays passed every test in this
    // file, because only the task-list side was pinned - the same one-sided
    // coverage that let three defects through on the previous step.
    expect(
      dirtySignature({
        ...blank(),
        inline_survey_questions: [{ _clientId: 'a1', prompt: 'How was it?' }]
      })
    ).toBe(
      dirtySignature({
        ...blank(),
        inline_survey_questions: [{ _clientId: 'b2', prompt: 'How was it?' }]
      })
    );
  });

  it('does not ignore anything else about a question', () => {
    expect(
      hasUnsavedChanges(
        { ...blank(), inline_survey_questions: [{ _clientId: 'a1', prompt: 'How was it?' }] },
        { ...blank(), inline_survey_questions: [{ _clientId: 'a1', prompt: 'How was it really?' }] }
      )
    ).toBe(true);
  });

  it('does not ignore anything else about a task', () => {
    // The twin of the test above, and the one that makes it mean something: if
    // the strip were dropping whole items rather than one key, both would pass.
    expect(
      hasUnsavedChanges(
        { ...blank(), inline_study_steps: [{ _clientId: 'a1', prompt: 'Find the export button' }] },
        { ...blank(), inline_study_steps: [{ _clientId: 'a1', prompt: 'Find the basket' }] }
      )
    ).toBe(true);
  });

  it('notices a task added to an empty list', () => {
    expect(
      hasUnsavedChanges({ ...blank(), inline_study_steps: [{ prompt: 'Do a thing' }] }, blank())
    ).toBe(true);
  });

  it('notices a question added to an empty list', () => {
    // Asserted separately from the task-list twin. Both arrays are stripped by
    // the same call, and covering one side only is how three C1 defects got in.
    expect(
      hasUnsavedChanges(
        { ...blank(), inline_survey_questions: [{ prompt: 'How was it?' }] },
        blank()
      )
    ).toBe(true);
  });

  it('notices a change to a field nobody thought to list', () => {
    // The whole reason this compares the object rather than a field list.
    expect(
      hasUnsavedChanges({ ...blank(), some_field_added_later: 'x' }, blank())
    ).toBe(true);
  });

  it('reports no change for a form that equals its baseline', () => {
    expect(hasUnsavedChanges(blank(), blank())).toBe(false);
  });
});
