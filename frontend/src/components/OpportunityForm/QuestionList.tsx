import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Copy,
  GripVertical,
  Trash2
} from 'lucide-react';

import ConfirmationModal from '../ConfirmationModal';
import {
  mintClientId,
  type WithClientId
} from '../../lib/opportunity-authoring/client-ids';
import { answerCountFor, removalMessage } from '../../lib/opportunity-authoring/answer-counts';
import './question-list.css';
import FieldError from './FieldError';
import { resolveMessage } from '../../lib/opportunity-authoring/error-summary';

/**
 * The least an authored item has to be for this list to render it.
 *
 * Deliberately not either vocabulary's own type. A survey question and a
 * recorded task share a prompt, a type and an optional list of options, and
 * nothing else - so everything else each of them needs comes back through
 * `renderTypeFields`, owned by the tab that knows which vocabulary it is in.
 * Merging the vocabularies here is what would let a rating widget appear in a
 * task list, which is refused by `authorableStepTypes` and pinned by a test.
 */
export interface AuthoredItem {
  type: string;
  prompt: string;
  options?: string[];
  is_required?: boolean;
}

interface QuestionListProps<T extends AuthoredItem> {
  items: WithClientId<T>[];
  onChange: (next: WithClientId<T>[]) => void;
  validationErrors: Record<string, string>;
  /** Error-key prefix, e.g. `inline_survey_questions`. */
  errorPrefix: string;
  /** DOM id prefix, e.g. `question`. */
  idPrefix: string;
  /**
   * Revalidate one item's field on blur, by its full error key.
   *
   * The key rather than the field name, because these rules are per item and
   * the collector produces `inline_survey_questions.2.prompt`. Optional so a
   * caller that has no validator to offer still renders.
   */
  onBlurField?: (errorKey: string) => void;
  /** What the author calls one of these: `question`, `task`. */
  noun: string;
  /** And several of them: `questions`, `tasks`. */
  nounPlural: string;
  /** Reader-facing name per type, used in the collapsed summary. */
  typeLabels: Record<string, string>;
  /**
   * The vocabulary the type selector offers, or null to suppress the selector.
   *
   * Null is not a stylistic choice: a recorded task list has no type selector
   * today, because its participants answer out loud, and adding one would be a
   * product change wearing a refactor's clothes.
   */
  typeVocabulary: readonly string[] | null;
  /** Non-destructive type change, owned by the caller's vocabulary. */
  onChangeType?: (item: WithClientId<T>, type: string) => WithClientId<T>;
  /** A brand-new item, in whatever this vocabulary's default shape is. */
  makeItem: () => T;
  /** The prompt label, which a survey varies by type. */
  promptLabel: (item: T) => string;
  promptPlaceholder?: string;
  /** Everything below the prompt that depends on the item's type. */
  renderTypeFields: (context: {
    item: WithClientId<T>;
    index: number;
    update: (patch: Partial<T>) => void;
  }) => React.ReactNode;
  addLabel: string;
  /**
   * The most items this list may hold. Unbounded when absent.
   *
   * Hides the add control at the cap rather than disabling it: a disabled
   * button invites a click and then explains nothing, and there is no state in
   * which the author can raise the cap from this screen - it is a property of
   * the opportunity TYPE, chosen two steps back.
   *
   * Not the enforcement. The server refuses an over-long payload whatever the
   * UI offers (see `maxQuestionsFor`), because this component is not a
   * boundary; it just declines to invite the refusal.
   */
  maxItems?: number;
  emptyMessage: string;
  /**
   * How many answers each item has already collected, keyed by `_clientId`.
   *
   * Optional, and absent for the recorded task list on purpose rather than by
   * omission: "Removed questions" is a section of the SURVEY results view, so
   * the sentence this drives would name a place a task list's author cannot go
   * and look. Wiring it up there means giving recorded studies the same
   * surfacing first.
   *
   * `null` is not the same as absent-and-therefore-empty. It means the count
   * could not be read, and the confirmation says so rather than implying there
   * are none - see `removalMessage`.
   */
  answerCounts?: Record<string, number> | null;
}

const summaryOf = (prompt: string): string => {
  const trimmed = prompt.trim();
  if (!trimmed) return '';
  return trimmed.length > 90 ? `${trimmed.slice(0, 90)}...` : trimmed;
};

const hasAuthoredContent = (item: AuthoredItem): boolean =>
  item.prompt.trim().length > 0 ||
  (item.options ?? []).some((option) => option.trim().length > 0);

/**
 * One list of authored questions or tasks, collapsed by default.
 *
 * Every card used to render fully expanded, so a twenty-question survey pushed
 * the consent field and the save controls several screens below the fold and
 * the author could not see the shape of what they had written. Collapsed, the
 * list is a list; the card the author is working on is the only one open.
 *
 * The reordering controls are deliberately three: Up/Down for a small nudge,
 * "move to position" for a list too long to nudge through, and a drag handle
 * for a mouse. The first two are the keyboard path and the accessible one -
 * dragging is an enhancement on top, never the only way, and every outcome is
 * announced in the live region below the list.
 */
function QuestionList<T extends AuthoredItem>({
  items,
  onChange,
  validationErrors,
  errorPrefix,
  idPrefix,
  onBlurField,
  noun,
  nounPlural,
  typeLabels,
  typeVocabulary,
  onChangeType,
  makeItem,
  promptLabel,
  promptPlaceholder,
  renderTypeFields,
  addLabel,
  maxItems,
  emptyMessage,
  answerCounts
}: QuestionListProps<T>) {
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const [announcement, setAnnouncement] = useState('');
  const [pendingRemoval, setPendingRemoval] = useState<{
    id: string;
    index: number;
  } | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const focusIdRef = useRef<string | null>(null);

  /**
   * The noun arrives lower case because that is what an accessible name wants -
   * "Move question 4 up". A sentence in the live region wants it capitalised,
   * and doing that here keeps one spelling of the word at the call sites.
   */
  const Noun = `${noun.charAt(0).toUpperCase()}${noun.slice(1)}`;

  /**
   * The message for one item's field, with its live position substituted in.
   *
   * `resolveMessage` rather than the raw string: per-item messages carry a
   * `{n}` placeholder, and the key this reads it by is the item's CURRENT
   * index, so a reorder renumbers the sentence. The summary resolves the same
   * stored string the same way, which is what keeps the two saying one thing.
   */
  const errorFor = (index: number, field: string): string | undefined => {
    const key = `${errorPrefix}.${index}.${field}`;
    const message = validationErrors[key];
    return message === undefined ? undefined : resolveMessage(key, message);
  };

  const itemHasError = (index: number): boolean =>
    Object.keys(validationErrors).some((key) =>
      key.startsWith(`${errorPrefix}.${index}.`)
    );

  /**
   * A refused save names the questions that failed and opens this step. A card
   * that stayed collapsed would hide the field the author was just sent to
   * fix, which is worse than never having collapsed it.
   *
   * It opens a card only when the SET of failing cards changes, not on every
   * render. `items` is a dependency and every keystroke makes a new array, so
   * an unconditional expand re-opened a card the author had deliberately
   * collapsed, every time they typed a character anywhere else in the list -
   * a card that will not stay shut.
   */
  const expandedForFailuresRef = useRef('');
  useEffect(() => {
    const failing = items
      .filter((_, index) =>
        Object.keys(validationErrors).some((key) =>
          key.startsWith(`${errorPrefix}.${index}.`)
        )
      )
      .map((item) => item._clientId);

    const signature = failing.join('|');
    if (signature === expandedForFailuresRef.current) return;
    expandedForFailuresRef.current = signature;

    setExpandedIds((previous) => {
      const toOpen = failing.filter((id) => !previous.includes(id));
      return toOpen.length === 0 ? previous : [...previous, ...toOpen];
    });
  }, [items, validationErrors, errorPrefix]);

  /** Focus follows a duplicate or an add, so the author types where they look. */
  useEffect(() => {
    const id = focusIdRef.current;
    if (!id) return;
    focusIdRef.current = null;
    document.getElementById(`${idPrefix}-prompt-${id}`)?.focus();
  }, [items, idPrefix]);

  const isExpanded = (id: string) => expandedIds.includes(id);

  const toggleExpanded = (id: string) =>
    setExpandedIds((previous) =>
      previous.includes(id)
        ? previous.filter((each) => each !== id)
        : [...previous, id]
    );

  const updateAt = (index: number, patch: Partial<T>) =>
    onChange(
      items.map((item, i) => (i === index ? { ...item, ...patch } : item))
    );

  const moveTo = (from: number, to: number) => {
    if (to < 0 || to >= items.length || to === from) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange(next);
    setAnnouncement(
      `${Noun} ${from + 1} moved to position ${to + 1} of ${items.length}.`
    );
  };

  const addItem = () => {
    const created = { ...makeItem(), _clientId: mintClientId() } as WithClientId<T>;
    focusIdRef.current = created._clientId;
    // Newly added items start expanded: an author who has just asked for one
    // wants to write it, and a collapsed empty card is a card with nothing in
    // it to read.
    setExpandedIds((previous) => [...previous, created._clientId]);
    onChange([...items, created]);
    setAnnouncement(`${Noun} ${items.length + 1} added.`);
  };

  /**
   * A deep copy, including options and any per-type config.
   *
   * A shallow one shares the options array, so editing an answer on the copy
   * silently rewrites it on the original - a data loss that looks like a
   * rendering bug.
   */
  const duplicateAt = (index: number) => {
    const copy = {
      ...structuredClone(items[index]),
      _clientId: mintClientId()
    } as WithClientId<T>;
    const next = [...items];
    next.splice(index + 1, 0, copy);
    focusIdRef.current = copy._clientId;
    setExpandedIds((previous) => [...previous, copy._clientId]);
    onChange(next);
    setAnnouncement(
      `${Noun} ${index + 1} duplicated. The copy is at position ${index + 2}.`
    );
  };

  /**
   * How many answers this card has collected, or undefined when that could not
   * be read.
   *
   * A list that does not offer counts at all - the recorded task list, which
   * has no "Removed questions" surface to send anyone to - is not the same as
   * one whose counts failed to load, and must not inherit the "could not be
   * checked" sentence for a check nothing ever tried to make. It answers zero,
   * which is what puts that list back on exactly the wording it had before this
   * existed.
   */
  const offersAnswerCounts = answerCounts !== undefined;
  const answersFor = (item: WithClientId<T>): number | undefined =>
    offersAnswerCounts ? answerCountFor(item._clientId, answerCounts) : 0;

  /**
   * The count for the card an open dialog is about, or undefined when that card
   * is no longer in the list.
   *
   * Resolved by id, not by the index captured when the dialog opened: the list
   * can change underneath it, because the form re-reads itself after every
   * successful save, and a count read by position would name a different
   * question's answers in a sentence nothing else on screen contradicts.
   *
   * BOTH lookups can miss - the card gone AND the captured index now past the
   * end, which is removing the last of three from outside with the dialog open
   * - and the old code dereferenced the result either way, so the whole
   * authoring surface went down with a render-time TypeError. The confirm
   * handler below already guarded this exact condition, which is what made the
   * omission an inconsistency rather than a decision.
   */
  const answersOfPending = (pending: { id: string; index: number }): number | undefined => {
    const target =
      items.find((item) => item._clientId === pending.id) ?? items[pending.index];
    return target ? answersFor(target) : undefined;
  };

  const removeAt = (index: number) => {
    const removed = items[index];
    const answers = answersFor(removed);
    setExpandedIds((previous) => previous.filter((id) => id !== removed._clientId));
    onChange(items.filter((_, i) => i !== index));
    // Announced with the consequence, not just the act. A screen reader user
    // who confirmed the dialog has already been told the number; one whose
    // card had no answers hears the sentence this list has always said.
    setAnnouncement(
      answers === undefined
        ? // The dialog just promised that any answers are kept. Falling back to
          // the bare sentence here told the one reader who cannot see the
          // screen least, having shown them the most cautious dialog.
          `${Noun} ${index + 1} removed. Whether it had been answered could not be checked; any answers are kept under Removed questions in the results.`
        : answers > 0
          ? `${Noun} ${index + 1} removed. Its ${answers} ${
              answers === 1 ? 'answer is' : 'answers are'
            } kept under Removed questions in the results.`
          : `${Noun} ${index + 1} removed.`
    );
  };

  /**
   * Confirmed when there is something to lose - and since F2 that is a wider
   * question than it was.
   *
   * It used to mean only "has the author written anything into this card",
   * because a question of a study with answers could not be removed at all:
   * the API refused the save outright. F2 allows it, so a card can now be worth
   * confirming for a reason that has nothing to do with what is typed in it -
   * three hundred people may have answered it. A prompt cleared before the
   * Remove button is pressed would otherwise skip the dialog entirely.
   *
   * The empty-card exemption stays for everything else. Confirming the removal
   * of a blank card the author just added is a dialog that teaches people to
   * dismiss dialogs, which is what makes the one that matters ineffective.
   */
  const requestRemove = (index: number) => {
    const answers = answersFor(items[index]);
    const worthConfirming =
      hasAuthoredContent(items[index]) || answers === undefined || answers > 0;

    if (!worthConfirming) {
      removeAt(index);
      return;
    }
    setPendingRemoval({ id: items[index]._clientId, index });
  };

  const handleDragStart = (
    event: React.DragEvent<HTMLLIElement>,
    index: number
  ) => {
    // Only the handle starts a drag. Without this the whole card is draggable,
    // and selecting text in the prompt drags the card instead.
    if (!(event.target as HTMLElement).closest?.('[data-drag-handle]')) {
      event.preventDefault();
      return;
    }
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(index));
    }
    setDragIndex(index);
  };

  const handleDragOver = (
    event: React.DragEvent<HTMLLIElement>,
    index: number
  ) => {
    if (dragIndex === null) return;
    event.preventDefault();
    setDragOverIndex(index);
  };

  const handleDrop = (event: React.DragEvent<HTMLLIElement>, index: number) => {
    if (dragIndex === null) return;
    event.preventDefault();
    moveTo(dragIndex, index);
    setDragIndex(null);
    setDragOverIndex(null);
  };

  const endDrag = () => {
    setDragIndex(null);
    setDragOverIndex(null);
  };

  return (
    <div className="question-list">
      {items.length === 0 ? (
        <p className="text-muted" style={{ fontSize: '0.95rem' }}>
          {emptyMessage}
        </p>
      ) : (
        // Named, because the error summary above renders a list too and a bare
        // `getAllByRole('listitem')` used to span both - a test counting
        // question cards silently started counting summary entries.
        <ol
          className="question-list__items list-unstyled"
          aria-label={`${nounPlural} in this list`}
        >
          {items.map((item, index) => {
            const expanded = isExpanded(item._clientId);
            const bodyId = `${idPrefix}-body-${item._clientId}`;
            const failing = itemHasError(index);

            return (
              <li
                key={item._clientId}
                className={`question-card${
                  dragOverIndex === index && dragIndex !== index
                    ? ' question-card--drop-target'
                    : ''
                }${failing ? ' question-card--needs-attention' : ''}`}
                draggable
                onDragStart={(event) => handleDragStart(event, index)}
                onDragOver={(event) => handleDragOver(event, index)}
                onDrop={(event) => handleDrop(event, index)}
                onDragEnd={endDrag}
              >
                <div className="question-card__header">
                  <span
                    className="question-card__grip"
                    data-drag-handle="true"
                    aria-hidden="true"
                  >
                    <GripVertical size={16} />
                  </span>

                  <button
                    type="button"
                    className="question-card__summary"
                    aria-expanded={expanded}
                    aria-controls={bodyId}
                    onClick={() => toggleExpanded(item._clientId)}
                  >
                    {expanded ? (
                      <ChevronDown size={16} aria-hidden="true" />
                    ) : (
                      <ChevronRight size={16} aria-hidden="true" />
                    )}
                    <span className="question-card__meta">
                      {index + 1}. {typeLabels[item.type] ?? item.type}
                      {item.is_required ? ' · Required' : ''}
                    </span>
                    <span className="question-card__prompt">
                      {summaryOf(item.prompt) || 'No wording yet'}
                    </span>
                    {failing && (
                      <span className="question-card__flag validation-error">
                        <AlertCircle size={14} aria-hidden="true" /> Needs attention
                      </span>
                    )}
                    {/*
                      Row 32: `.question-card__toggle` underlines this text
                      (question-list.css), which makes "Edit" read as its own
                      link sitting inside a bigger button - when the whole
                      row, not just this word, is what toggles the card. The
                      underline is a CSS-file change outside this file's
                      boundary, so it is overridden inline here instead of
                      left to mislead.
                    */}
                    <span
                      className="question-card__toggle"
                      style={{ textDecoration: 'none' }}
                    >
                      {expanded ? 'Collapse' : 'Edit'}
                    </span>
                  </button>

                  <div className="question-card__controls">
                    <button
                      type="button"
                      className="question-card__control"
                      onClick={() => moveTo(index, index - 1)}
                      disabled={index === 0}
                      aria-label={`Move ${noun} ${index + 1} up`}
                    >
                      <ArrowUp size={16} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="question-card__control"
                      onClick={() => moveTo(index, index + 1)}
                      disabled={index === items.length - 1}
                      aria-label={`Move ${noun} ${index + 1} down`}
                    >
                      <ArrowDown size={16} aria-hidden="true" />
                    </button>
                    <select
                      className="question-card__position"
                      aria-label={`Move ${noun} ${index + 1} to position`}
                      // A bare number beside two arrows says nothing to a
                      // sighted reader about what changing it does.
                      title={`Move this ${noun} to another position`}
                      value={index + 1}
                      onChange={(event) =>
                        moveTo(index, Number(event.target.value) - 1)
                      }
                    >
                      {items.map((_, position) => (
                        <option key={position} value={position + 1}>
                          {position + 1}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="question-card__control"
                      onClick={() => duplicateAt(index)}
                      aria-label={`Duplicate ${noun} ${index + 1}`}
                    >
                      <Copy size={16} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="question-card__control question-card__control--danger"
                      onClick={() => requestRemove(index)}
                      aria-label={`Remove ${noun} ${index + 1}`}
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </button>
                  </div>
                </div>

                {expanded && (
                  <div className="question-card__body" id={bodyId}>
                    {typeVocabulary && onChangeType && (
                      <div className="form-group mb-3">
                        <label
                          className="form-label"
                          htmlFor={`${idPrefix}-type-${item._clientId}`}
                        >
                          Type
                        </label>
                        <select
                          className="form-control form-select"
                          id={`${idPrefix}-type-${item._clientId}`}
                          value={item.type}
                          onChange={(event) =>
                            onChange(
                              items.map((each, i) =>
                                i === index
                                  ? onChangeType(each, event.target.value)
                                  : each
                              )
                            )
                          }
                        >
                          {typeVocabulary.map((type) => (
                            <option key={type} value={type}>
                              {typeLabels[type] ?? type}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

                    <div className="form-group mb-3">
                      <label
                        className="form-label"
                        htmlFor={`${idPrefix}-prompt-${item._clientId}`}
                      >
                        {promptLabel(item)}
                      </label>
                      <textarea
                        className="form-control"
                        id={`${idPrefix}-prompt-${item._clientId}`}
                        rows={2}
                        value={item.prompt}
                        placeholder={promptPlaceholder}
                        onChange={(event) =>
                          updateAt(index, { prompt: event.target.value } as Partial<T>)
                        }
                        onBlur={() => onBlurField?.(`${errorPrefix}.${index}.prompt`)}
                      />
                      {errorFor(index, 'prompt') && (
                        <FieldError>{errorFor(index, 'prompt')}</FieldError>
                      )}
                    </div>

                    {renderTypeFields({
                      item,
                      index,
                      update: (patch) => updateAt(index, patch)
                    })}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {maxItems !== undefined && items.length >= maxItems ? null : (
        <button type="button" className="btn btn-outline-primary" onClick={addItem}>
          {addLabel}
        </button>
      )}

      {/*
        One region for every outcome the list can produce. Moving a card with
        the keyboard otherwise reports nothing at all: the card is somewhere
        else on screen, and a screen reader is told none of it.
      */}
      <div className="visually-hidden" aria-live="polite" role="status">
        {announcement}
      </div>

      <ConfirmationModal
        show={pendingRemoval !== null}
        title={`Remove this ${noun}?`}
        message={
          pendingRemoval
            ? removalMessage(
                pendingRemoval.index + 1,
                noun,
                nounPlural,
                // Resolved by id for the same reason the confirm handler below
                // is: the list can change under an open dialog, and a count
                // read by the index captured when it opened would name a
                // different question's answers.
                answersOfPending(pendingRemoval)
              )
            : ''
        }
        confirmLabel={`Remove ${noun}`}
        cancelLabel="Keep it"
        variant="danger"
        onConfirm={() => {
          // Resolved by id, not by the index captured when the dialog opened.
          // A save applies to a linked study by deleting every stored step and
          // re-inserting what the payload carried, so removing the wrong
          // question here is silent, permanent loss - and the list can change
          // underneath an open dialog, because the form re-reads itself after
          // every successful save.
          const index = pendingRemoval
            ? items.findIndex((item) => item._clientId === pendingRemoval.id)
            : -1;
          if (index >= 0) removeAt(index);
          setPendingRemoval(null);
        }}
        onCancel={() => setPendingRemoval(null)}
      />
    </div>
  );
}

export default QuestionList;
