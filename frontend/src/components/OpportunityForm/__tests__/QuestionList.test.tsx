import React, { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import QuestionList from '../QuestionList';
import {
  withClientIds,
  type WithClientId
} from '../../../lib/opportunity-authoring/client-ids';

vi.mock('../../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'light', isDarkMode: false })
}));

/**
 * The shared question and task list.
 *
 * Every card used to render fully expanded, in an `<ol>` keyed by ARRAY INDEX,
 * with Up/Down/Remove and nothing else. Two defects came out of that: a
 * twenty-question survey pushed every other control off the screen, and
 * reordering re-keyed each card below the one that moved, so React reused the
 * DOM across different questions and uncommitted keystrokes landed on the wrong
 * one.
 */
type Question = {
  type: string;
  prompt: string;
  options?: string[];
  config?: { scale_max?: number };
  is_required?: boolean;
};

const TYPE_LABELS: Record<string, string> = {
  instruction: 'Section text (no answer)',
  open_text: 'Free text',
  single_choice: 'Choose one',
  rating: 'Rating scale',
  nps: 'Recommendation score (0 to 10)'
};

/** Three questions, all different, so a wrong index cannot pass by luck. */
const THREE: Question[] = [
  { type: 'open_text', prompt: 'Which tool slows you down?' },
  {
    type: 'single_choice',
    prompt: 'Which delivery option would you pick?',
    options: ['Standard', 'Next day'],
    is_required: true
  },
  { type: 'rating', prompt: 'How happy are you with it?', config: { scale_max: 7 } }
];

interface HarnessProps {
  initial?: Question[];
  validationErrors?: Record<string, string>;
  /**
   * The live array, by reference.
   *
   * The serialised copy below cannot answer "is this the SAME array" - and that
   * is the only question a deep copy is about. Asserting through an edit
   * instead proved the option editor was immutable, and passed with the deep
   * copy replaced by a spread.
   */
  onItems?: (items: WithClientId<Question>[]) => void;
}

/**
 * State lives in the parent in the real form too, so the harness holds it here
 * rather than reaching into the component. The serialised copy is what the
 * state assertions read - the payload builders are tested against the real
 * form elsewhere, and a rendered value would not show what type-switching
 * PRESERVED.
 */
const Harness: React.FC<HarnessProps> = ({
  initial = THREE,
  validationErrors = {},
  onItems
}) => {
  const [items, setItems] = useState<WithClientId<Question>[]>(() =>
    withClientIds(initial)
  );

  onItems?.(items);

  return (
    <>
      <QuestionList
        items={items}
        onChange={setItems}
        validationErrors={validationErrors}
        errorPrefix="inline_survey_questions"
        idPrefix="question"
        noun="question"
        nounPlural="questions"
        typeLabels={TYPE_LABELS}
        typeVocabulary={['open_text', 'single_choice', 'rating', 'nps']}
        onChangeType={(item, type) => {
          const next = { ...item, type };
          if (type === 'single_choice' && (next.options ?? []).length === 0) {
            next.options = ['', ''];
          }
          return next;
        }}
        makeItem={(): Question => ({ type: 'open_text', prompt: '' })}
        promptLabel={() => 'What the participant is asked *'}
        addLabel="Add question"
        emptyMessage="No questions yet."
        renderTypeFields={({ item, index, update }) =>
          item.type === 'single_choice' ? (
            <div>
              {(item.options ?? []).map((option, optionIndex) => (
                <input
                  key={optionIndex}
                  aria-label={`Answer ${optionIndex + 1} for question ${index + 1}`}
                  value={option}
                  onChange={(event) =>
                    update({
                      options: (item.options ?? []).map((each, i) =>
                        i === optionIndex ? event.target.value : each
                      )
                    })
                  }
                />
              ))}
            </div>
          ) : null
        }
      />
      {/* Changes the list from outside the component, which is what a
          re-read after a save does. Used to open a dialog and then move the
          ground under it. */}
      <button type="button" onClick={() => setItems([...items].reverse())}>
        reverse from outside
      </button>
      <pre data-testid="state">
        {JSON.stringify(items.map(({ _clientId: _ignored, ...rest }) => rest))}
      </pre>
    </>
  );
};

const state = (): Question[] =>
  JSON.parse(screen.getByTestId('state').textContent ?? '[]');

/**
 * An expanded card carries its wording twice - once in the collapsed summary
 * and once in the textarea - so this takes the first match rather than
 * insisting on a unique one. Both are inside the same card either way.
 */
const cardFor = (prompt: string): HTMLElement =>
  screen.getAllByText(prompt)[0].closest('li') as HTMLElement;

describe('collapsing', () => {
  /**
   * Long wording is truncated so a twenty-question list stays one row a
   * question. The commit claims this; nothing asserted it.
   */
  it('truncates wording too long for one row', () => {
    const long =
      'Which part of the release process is hardest to explain to a new joiner, and what would you change about it first?';
    render(<Harness initial={[{ type: 'open_text', prompt: long }]} />);

    const summary = document.querySelector('.question-card__prompt') as HTMLElement;
    expect(summary.textContent).toMatch(/\.\.\.$/);
    expect(summary.textContent!.length).toBeLessThan(long.length);
  });

  /**
   * The auto-expand runs off `items`, and every keystroke anywhere in the list
   * makes a new `items`. Without a guard it re-opened a card the author had
   * deliberately collapsed, every time they typed a character in another one -
   * a card that will not stay shut.
   */
  it('leaves a failing card collapsed once the author has closed it', () => {
    render(
      <Harness
        validationErrors={{
          'inline_survey_questions.1.prompt': 'Add what the participant is asked'
        }}
      />
    );

    const failing = cardFor('Which delivery option would you pick?');
    fireEvent.click(within(failing).getByRole('button', { expanded: true }));
    expect(within(failing).getByRole('button', { expanded: false })).toBeInTheDocument();

    fireEvent.click(
      within(cardFor('Which tool slows you down?')).getByRole('button', {
        expanded: false
      })
    );
    fireEvent.change(screen.getByLabelText(/What the participant is asked/i), {
      target: { value: 'Which tool slows you down the most?' }
    });

    expect(
      within(cardFor('Which delivery option would you pick?')).getByRole('button', {
        expanded: false
      })
    ).toBeInTheDocument();
  });
  it('starts every card collapsed, showing position, type and wording', () => {
    render(<Harness />);

    expect(screen.getAllByRole('button', { expanded: false })).toHaveLength(3);
    expect(screen.queryByLabelText(/What the participant is asked/i)).toBeNull();

    const second = cardFor('Which delivery option would you pick?');
    expect(second).toHaveTextContent('2. Choose one · Required');
  });

  it('opens one card without opening the others', () => {
    render(<Harness />);

    fireEvent.click(
      within(cardFor('Which tool slows you down?')).getByRole('button', {
        expanded: false
      })
    );

    expect(screen.getAllByLabelText(/What the participant is asked/i)).toHaveLength(1);
    expect(screen.getAllByRole('button', { expanded: false })).toHaveLength(2);
  });

  /**
   * A refused save names the questions that failed and opens this step. A card
   * that stayed shut would hide the field the author was just sent to fix.
   */
  it('opens a card that has a validation error, and flags it', () => {
    render(
      <Harness
        validationErrors={{
          'inline_survey_questions.1.prompt': 'Add what the participant is asked'
        }}
      />
    );

    const failing = cardFor('Which delivery option would you pick?');
    expect(within(failing).getByRole('button', { expanded: true })).toBeInTheDocument();
    expect(failing).toHaveTextContent('Needs attention');
    expect(within(failing).getByRole('alert')).toHaveTextContent(
      'Add what the participant is asked'
    );

    // Only that one. A blanket expansion would satisfy the assertion above and
    // undo the whole collapse.
    expect(screen.getAllByRole('button', { expanded: false })).toHaveLength(2);
  });

  it('starts a newly added question expanded, because it has nothing to read', () => {
    render(<Harness initial={[]} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add question' }));

    expect(screen.getByRole('button', { expanded: true })).toBeInTheDocument();
    expect(screen.getByLabelText(/What the participant is asked/i)).toHaveValue('');
  });

  /**
   * And the cursor is in it. An author who has just asked for a question wants
   * to write it, not hunt for where it landed - which matters most in the long
   * list this whole change is for, where the new card is off the bottom.
   */
  it('puts the cursor in a question it has just added or copied', () => {
    let items: WithClientId<Question>[] = [];
    render(<Harness onItems={(latest) => { items = latest; }} />);

    // Asserted against the new item's own id rather than a position in the
    // rendered list: only expanded cards render a prompt field at all, so a
    // positional lookup would be reading a different list from the one the
    // focus is being placed in.
    fireEvent.click(screen.getByRole('button', { name: 'Add question' }));
    expect(document.activeElement?.id).toBe(`question-prompt-${items[3]._clientId}`);

    fireEvent.click(screen.getByRole('button', { name: 'Duplicate question 1' }));
    expect(document.activeElement?.id).toBe(`question-prompt-${items[1]._clientId}`);
  });
});

describe('reordering', () => {
  /**
   * Drag both ways. Dropping onto a card lands AFTER it going down and BEFORE
   * it going up, which is what splice does and what the move-to-position
   * control does. Testing one direction only let an off-by-one through:
   * `moveTo(from, Math.max(0, to - 1))` is invisible to an upward drag onto
   * index 0.
   */
  it('reorders on a drop from the drag handle, in both directions', () => {
    render(<Harness />);
    const dragTo = (fromPrompt: string, ontoPrompt: string) => {
      const handle = cardFor(fromPrompt).querySelector(
        '[data-drag-handle]'
      ) as HTMLElement;
      // Fired ON the handle so it bubbles to the card with the handle as its
      // target, which is what the card checks before allowing the drag.
      fireEvent.dragStart(handle);
      fireEvent.dragOver(cardFor(ontoPrompt));
      fireEvent.drop(cardFor(ontoPrompt));
    };

    dragTo('How happy are you with it?', 'Which tool slows you down?');
    expect(state().map((item) => item.prompt)).toEqual([
      'How happy are you with it?',
      'Which tool slows you down?',
      'Which delivery option would you pick?'
    ]);

    dragTo('How happy are you with it?', 'Which delivery option would you pick?');
    expect(state().map((item) => item.prompt)).toEqual([
      'Which tool slows you down?',
      'Which delivery option would you pick?',
      'How happy are you with it?'
    ]);
  });

  /**
   * Choosing the position a question is already at must do nothing at all.
   * Announcing "moved to position 2" when nothing moved is a screen reader
   * being told something untrue.
   */
  it('says nothing when a move would not move anything', () => {
    render(<Harness />);

    fireEvent.change(
      screen.getByRole('combobox', { name: 'Move question 2 to position' }),
      { target: { value: '2' } }
    );

    expect(screen.getByRole('status')).toHaveTextContent('');
    expect(state().map((item) => item.prompt)).toEqual([
      'Which tool slows you down?',
      'Which delivery option would you pick?',
      'How happy are you with it?'
    ]);
  });
  /**
   * The defect the client id exists for. With index keys React reuses the DOM
   * node at each position, so the element holding question 1 becomes question 2
   * rather than moving with it - and an uncommitted keystroke goes with it.
   */
  it('moves the card element itself rather than re-keying the position', () => {
    render(<Harness />);
    const moved = cardFor('Which tool slows you down?');

    fireEvent.click(screen.getByRole('button', { name: 'Move question 1 down' }));

    expect(cardFor('Which tool slows you down?')).toBe(moved);
    expect(state().map((item) => item.prompt)).toEqual([
      'Which delivery option would you pick?',
      'Which tool slows you down?',
      'How happy are you with it?'
    ]);
  });

  it('moves a question straight to a chosen position', () => {
    render(<Harness />);

    fireEvent.change(
      screen.getByRole('combobox', { name: 'Move question 3 to position' }),
      { target: { value: '1' } }
    );

    expect(state().map((item) => item.prompt)).toEqual([
      'How happy are you with it?',
      'Which tool slows you down?',
      'Which delivery option would you pick?'
    ]);
  });

  it('says what happened, for a reader who cannot see the list move', () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'Move question 3 up' }));

    expect(screen.getByRole('status')).toHaveTextContent(
      'Question 3 moved to position 2 of 3.'
    );
  });

  it('disables the move that would go off either end', () => {
    render(<Harness />);

    expect(screen.getByRole('button', { name: 'Move question 1 up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move question 3 down' })).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Move question 1 down' })
    ).not.toBeDisabled();
  });

  /**
   * Dragging from anywhere else has to be refused, or selecting text in a
   * prompt drags the card instead of the text.
   */
  it('refuses a drag that did not start on the handle', () => {
    render(<Harness />);
    const source = cardFor('How happy are you with it?');

    fireEvent.dragStart(source);
    fireEvent.dragOver(cardFor('Which tool slows you down?'));
    fireEvent.drop(cardFor('Which tool slows you down?'));

    expect(state().map((item) => item.prompt)).toEqual([
      'Which tool slows you down?',
      'Which delivery option would you pick?',
      'How happy are you with it?'
    ]);
  });
});

describe('duplicating', () => {
  it('inserts a deep copy below the original', () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'Duplicate question 2' }));

    expect(state().map((item) => item.prompt)).toEqual([
      'Which tool slows you down?',
      'Which delivery option would you pick?',
      'Which delivery option would you pick?',
      'How happy are you with it?'
    ]);
    expect(state()[2].options).toEqual(['Standard', 'Next day']);
  });

  /**
   * The assertion that matters, and it has to be about IDENTITY.
   *
   * A shallow copy shares the options array and the config object with the
   * original, so anything that ever mutates one in place rewrites the other -
   * a data loss that reads as a rendering bug. Asserting it through an edit
   * instead proves only that the option editor happens to be immutable today:
   * that version of this test passed with `structuredClone` replaced by a
   * spread, which is the whole reason this one is written by reference.
   */
  it('gives the copy its own options array and its own config', () => {
    let items: WithClientId<Question>[] = [];
    render(<Harness onItems={(latest) => { items = latest; }} />);

    fireEvent.click(screen.getByRole('button', { name: 'Duplicate question 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate question 4' }));

    expect(items[2].options).toEqual(items[1].options);
    expect(items[2].options).not.toBe(items[1].options);
    expect(items[4].config).toEqual(items[3].config);
    expect(items[4].config).not.toBe(items[3].config);
  });

  /**
   * The end-to-end property the identity assertion protects: editing the copy
   * leaves the original alone. Kept alongside rather than instead of it,
   * because this one passes against a shallow copy too.
   */
  it('leaves the original alone when the copy is edited', () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'Duplicate question 2' }));
    fireEvent.change(screen.getByLabelText('Answer 1 for question 3'), {
      target: { value: 'Collect in store' }
    });

    expect(state()[2].options).toEqual(['Collect in store', 'Next day']);
    expect(state()[1].options).toEqual(['Standard', 'Next day']);
  });

  it('opens the copy so the author can change what they just cloned', () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'Duplicate question 1' }));

    expect(screen.getAllByRole('button', { expanded: true })).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Question 1 duplicated. The copy is at position 2.'
    );
  });
});

describe('removing', () => {
  it('asks before dropping a question with wording in it', () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove question 2' }));

    expect(state()).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Remove question' }));

    expect(state().map((item) => item.prompt)).toEqual([
      'Which tool slows you down?',
      'How happy are you with it?'
    ]);
  });

  it('keeps the question when the author backs out', () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove question 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));

    expect(state()).toHaveLength(3);
  });

  /**
   * Confirming the removal of a card the author added seconds ago and has not
   * written in is a dialog that teaches people to dismiss dialogs.
   */
  /**
   * A choice question can carry four written answers and no prompt yet. The two
   * tests either side of this one are polarised - one item with both, one with
   * neither - so dropping the options half of the guard was invisible to both.
   */
  it('asks about a question with answers but no wording yet', () => {
    render(
      <Harness
        initial={[
          { type: 'single_choice', prompt: '  ', options: ['Standard', 'Next day'] }
        ]}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove question 1' }));

    expect(state()).toHaveLength(1);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  /**
   * The dialog stores which question it is about, and the list can change
   * underneath it - the form re-reads itself after every successful save. A
   * removal that resolved by the index captured when the dialog opened would
   * delete a different question, and a save applies to a linked study by
   * deleting every stored step and re-inserting the payload, so that is silent
   * and permanent.
   */
  it('removes the question it asked about, even if the list moved underneath', () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove question 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'reverse from outside' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove question' }));

    // The list is reversed, so question 1 is now last - and it is the one that
    // goes. An index-based removal would have taken the rating instead.
    expect(state().map((item) => item.prompt)).toEqual([
      'How happy are you with it?',
      'Which delivery option would you pick?'
    ]);
  });

  it('does not ask about an empty question', () => {
    render(<Harness initial={[{ type: 'open_text', prompt: '   ' }]} />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove question 1' }));

    expect(state()).toHaveLength(0);
  });
});

describe('changing type', () => {
  /**
   * The change applies to ONE question. Asserting only the question that was
   * changed leaves `items.map((each) => onChangeType(each, type))` - retyping
   * every question in the survey and seeding empty answers over all of them -
   * completely invisible. A three-item fixture is not enough on its own; the
   * other two have to be read.
   */
  it('changes the type of one question and leaves the rest alone', () => {
    render(<Harness />);

    fireEvent.click(
      within(cardFor('Which delivery option would you pick?')).getByRole('button', {
        expanded: false
      })
    );
    fireEvent.change(screen.getByLabelText('Type'), {
      target: { value: 'rating' }
    });

    expect(state().map((item) => item.type)).toEqual([
      'open_text',
      'rating',
      'rating'
    ]);
    expect(state()[0]).toEqual({
      type: 'open_text',
      prompt: 'Which tool slows you down?'
    });
    expect(state()[2]).toEqual({
      type: 'rating',
      prompt: 'How happy are you with it?',
      config: { scale_max: 7 }
    });
  });

  it('keeps the answers the author wrote when the type no longer shows them', () => {
    render(<Harness />);

    fireEvent.click(
      within(cardFor('Which delivery option would you pick?')).getByRole('button', {
        expanded: false
      })
    );
    fireEvent.change(screen.getByLabelText('Type'), {
      target: { value: 'open_text' }
    });

    expect(state()[1].type).toBe('open_text');
    expect(state()[1].options).toEqual(['Standard', 'Next day']);

    fireEvent.change(screen.getByLabelText('Type'), {
      target: { value: 'single_choice' }
    });

    expect(state()[1].options).toEqual(['Standard', 'Next day']);
  });

  /**
   * A recorded task list has no type selector, and adding one would be a
   * product change rather than a refactor - its participants answer aloud.
   */
  it('renders no type selector when the vocabulary is suppressed', () => {
    render(
      <>
        <QuestionList
          items={withClientIds([{ type: 'instruction', prompt: 'Open the basket' }])}
          onChange={() => undefined}
          validationErrors={{}}
          errorPrefix="inline_study_steps"
          idPrefix="task"
          noun="task"
          nounPlural="tasks"
          typeLabels={{ instruction: 'Task' }}
          typeVocabulary={null}
          makeItem={() => ({ type: 'instruction', prompt: '' })}
          promptLabel={() => 'What the participant sees *'}
          addLabel="Add task"
          emptyMessage="No tasks yet."
          renderTypeFields={() => null}
        />
      </>
    );

    fireEvent.click(screen.getByRole('button', { expanded: false }));

    expect(screen.queryByLabelText('Type')).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove task 1' })).toBeInTheDocument();
  });
});
