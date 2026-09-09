import React, { useState } from 'react';

import {
  getFirstHandStudy,
  type FirstHandStudyWithSteps,
  wasRateLimited
} from '../../api/firsthand-studies';
import type { FirstHandStudy } from '../../api/types';
import ConsentStateChip from '../ConsentStateChip';

interface StudySourcePickerProps {
  /** Already filtered to what this surface can actually author. */
  studies: FirstHandStudy[];
  /** How many of this surface's kind are waiting in draft. */
  draftCount: number;
  loading: boolean;
  fetchError: string;
  onRetry: () => void;
  /**
   * Takes the copy. Resolves to an error message when the copy cannot be taken,
   * or null when it worked - the decision needs the form's own round-trip
   * check, so it is not re-implemented here.
   */
  onChoose: (studyId: string) => Promise<string | null>;
  /** Whose sets these are, for the ownership line on each row. */
  currentUserId?: string;
  /**
   * Offered only when there is something to go back TO - i.e. the chooser was
   * reopened over a copy that has already been taken. Without it the only exits
   * from a reopened list were taking another copy or moving the radio, so
   * "Choose a different set" was a one-way door.
   */
  onCancel?: () => void;
  /**
   * Opens E1's participant preview on a stored set, before it is copied.
   *
   * Optional: a caller that cannot show a preview passes nothing and the
   * control is not offered, rather than being offered and doing nothing. The
   * whole loaded study is handed up rather than an id, because the caller
   * unmounts this component to draw the preview - so refetching from there
   * would mean a second request for content already in hand.
   */
  onPreviewStudy?: (study: FirstHandStudyWithSteps) => void;
  /** `question` / `task`, singular, lower case. */
  noun: string;
  /** What this surface calls a whole set, e.g. "set of questions". */
  setNoun: string;
  idPrefix: string;
}

const formatUpdated = (value?: string): string => {
  if (!value) return 'Never updated';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Never updated';
  return `Updated ${date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  })}`;
};

/**
 * The rows an author picks a starting point from.
 *
 * The control this replaces was a bare `<select>` of titles. A title alone is
 * not enough to choose between two sets six months after either was written:
 * the questions the author actually needs to compare are how many there are,
 * whether it has been touched recently, whether it is theirs, and - the only
 * one that settles it - what is actually in it. So each row carries all four,
 * and the last is a disclosure rather than a navigation away from a half-filled
 * form.
 *
 * Ownership is shown as "Yours" or "Someone else's" rather than as a name.
 * `owner_user_id` is all the studies list carries, and resolving it to a person
 * means a second lookup across the schema boundary that exists precisely to
 * keep `users` and `studies` apart. The question a picker actually answers is
 * "is this mine", and that needs no lookup at all.
 */
const StudySourcePicker: React.FC<StudySourcePickerProps> = ({
  studies,
  draftCount,
  loading,
  fetchError,
  onRetry,
  onChoose,
  onCancel,
  onPreviewStudy,
  currentUserId,
  noun,
  setNoun,
  idPrefix
}) => {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /**
   * The loaded study, whole, keyed by id - not just its steps.
   *
   * It used to hold the filtered step list alone. E1's participant preview
   * needs the study's title, intro and consent wording as well, and keeping a
   * second map for those would be two things read from one response that can
   * fall out of step with each other. One map, filtered where it is rendered.
   */
  const [loadedStudies, setLoadedStudies] = useState<
    Record<string, FirstHandStudyWithSteps>
  >({});
  const [copyingId, setCopyingId] = useState<string | null>(null);

  /**
   * Both keyed BY STUDY rather than held as one value.
   *
   * Single-valued versions of these are wrong in two ways that both read as a
   * true statement about the wrong row. Expand A, then expand B before A
   * resolves: A's `finally` clears the shared loading id, so B renders its
   * empty state and says "this set has nothing in it" about a set that has
   * content. And a failure on A closed B and blamed B for it. The copy error
   * had the matching problem in the other direction - it rendered above the
   * whole list, so on a long list a refusal appeared off screen from the button
   * that caused it, contradicting this component's own prop doc.
   */
  const [previewErrors, setPreviewErrors] = useState<Record<string, string>>({});
  const [previewLoadingIds, setPreviewLoadingIds] = useState<string[]>([]);
  const [copyErrors, setCopyErrors] = useState<Record<string, string>>({});

  const togglePreview = async (studyId: string) => {
    setPreviewErrors((previous) => ({ ...previous, [studyId]: '' }));
    if (expandedId === studyId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(studyId);
    if (loadedStudies[studyId]) return;

    setPreviewLoadingIds((previous) => [...previous, studyId]);
    try {
      const loaded = await getFirstHandStudy(studyId);
      setLoadedStudies((previous) => ({ ...previous, [studyId]: loaded }));
    } catch (error) {
      setPreviewErrors((previous) => ({
        ...previous,
        [studyId]: wasRateLimited(error)
          ? `Too many previews in a short time. Wait a minute and try again.`
          : `Could not load that ${setNoun} to preview it.`
      }));
      // Collapsed by id, so a failure cannot close whichever row the author
      // happens to have open now.
      setExpandedId((current) => (current === studyId ? null : current));
    } finally {
      setPreviewLoadingIds((previous) => previous.filter((id) => id !== studyId));
    }
  };

  const choose = async (studyId: string) => {
    setCopyErrors((previous) => ({ ...previous, [studyId]: '' }));
    setCopyingId(studyId);
    try {
      const failure = await onChoose(studyId);
      if (failure) setCopyErrors((previous) => ({ ...previous, [studyId]: failure }));
    } finally {
      setCopyingId(null);
    }
  };

  if (loading) {
    return (
      <div className="text-muted" style={{ fontSize: '0.875rem' }}>
        <span
          className="spinner-border spinner-border-sm me-2"
          role="status"
          aria-hidden="true"
        />
        Loading {setNoun}s...
      </div>
    );
  }

  if (fetchError) {
    return (
      <div className="alert alert-warning py-2 px-3 mb-2">
        <span className="me-2">{fetchError}</span>
        <button type="button" className="btn btn-sm btn-outline-secondary" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }

  if (studies.length === 0) {
    return (
      <div className="form-text">
        {draftCount > 0
          ? `Nothing published to start from yet. ${draftCount} in draft - publish one in the Task Lists area, or choose "Create ${noun}s for this study" above.`
          : `Nothing to start from yet. Choose "Create ${noun}s for this study" above.`}
      </div>
    );
  }

  return (
    <div>
      {onCancel && (
        <button
          type="button"
          className="btn btn-sm btn-link p-0 mb-2"
          onClick={onCancel}
        >
          Keep the {setNoun} already copied in
        </button>
      )}
      <ul className="list-unstyled mb-0" data-testid={`${idPrefix}-source-list`}>
        {studies.map((study) => {
          const expanded = expandedId === study.id;
          const loaded = loadedStudies[study.id];
          // The completion marker is machinery, not something anyone authored,
          // so it is not listed as one of the questions being previewed.
          const steps = (loaded?.steps ?? []).filter((step) => step.type !== 'end');
          const previewLoading = previewLoadingIds.includes(study.id);
          const previewFailure = previewErrors[study.id];
          const copyFailure = copyErrors[study.id];
          const panelId = `${idPrefix}-preview-${study.id}`;
          return (
            <li
              key={study.id}
              className="border rounded p-3 mb-2"
              data-testid={`${idPrefix}-source-row`}
            >
              <div className="d-flex flex-wrap justify-content-between align-items-start gap-2">
                <div>
                  <div style={{ fontWeight: 600 }}>
                    {study.title}{' '}
                    {/* Shown BEFORE the copy is taken, not after. A copy
                        inherits the source's consent wording and its
                        classification with it, so "this one runs on custom
                        wording" is something the author needs while choosing,
                        not something to discover on the Consent step once the
                        decision has been made. */}
                    <ConsentStateChip templateId={study.consent_template_id} />
                  </div>
                  <div className="text-muted" style={{ fontSize: '0.85rem' }}>
                    {/* `authored_step_count` is derived by the list endpoint and
                        excludes the completion marker, so this is the number of
                        things a participant is actually asked. Absent rather
                        than zero when the server did not send it - saying "0
                        questions" about a set that has some is worse than
                        saying nothing. */}
                    {study.authored_step_count === undefined
                      ? null
                      : `${study.authored_step_count} ${
                          study.authored_step_count === 1 ? noun : `${noun}s`
                        } · `}
                    {formatUpdated(study.updated_at)}
                    {' · '}
                    {study.owner_user_id && currentUserId && study.owner_user_id === currentUserId
                      ? 'Yours'
                      : study.owner_user_id
                        ? "Someone else's"
                        : 'No owner recorded'}
                  </div>
                </div>
                <div className="d-flex gap-2">
                  {/* Both buttons carry the title in their accessible name. A
                      list of N rows otherwise offers N controls all called
                      "Preview" and N all called "Start from this", and the
                      second one decides which content gets copied - so a
                      screen-reader user navigating by button list had no way to
                      tell which set they were about to take.

                      Carried by a VISUALLY HIDDEN span rather than by
                      `aria-label`, which is what this was first written with and
                      is wrong here. An aria-label REPLACES the accessible name,
                      so "Start from Demo Study" would no longer contain the
                      visible words "Start from this" - and WCAG 2.5.3 (Label in
                      Name) exists because a speech-input user says what they can
                      SEE. Appending keeps the visible label a prefix of the
                      accessible one. aria-label is right on the icon-only
                      controls in QuestionList, which have no visible text at
                      all; it is not right here. */}
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-secondary"
                    aria-expanded={expanded}
                    aria-controls={panelId}
                    onClick={() => void togglePreview(study.id)}
                  >
                    {expanded ? 'Hide preview' : 'Preview'}
                    <span className="visually-hidden"> {study.title}</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={copyingId !== null}
                    onClick={() => void choose(study.id)}
                  >
                    {copyingId === study.id ? 'Copying...' : 'Start from this'}
                    <span className="visually-hidden"> {study.title}</span>
                  </button>
                </div>
              </div>

              {/* Beside the row that was clicked, not above the whole list. */}
              {copyFailure && (
                <div className="alert alert-warning py-2 px-3 mt-3 mb-0" role="alert">
                  {copyFailure}
                </div>
              )}
              {previewFailure && (
                <div className="alert alert-warning py-2 px-3 mt-3 mb-0" role="alert">
                  {previewFailure}
                </div>
              )}

              {expanded && (
                <div id={panelId} className="mt-3 pt-3 border-top">
                  {previewLoading ? (
                    <div className="text-muted" style={{ fontSize: '0.875rem' }}>
                      Loading preview...
                    </div>
                  ) : steps.length === 0 ? (
                    <div className="text-muted" style={{ fontSize: '0.875rem' }}>
                      This {setNoun} has nothing in it.
                    </div>
                  ) : (
                    <>
                      <ol className="mb-0 ps-3" style={{ fontSize: '0.9rem' }}>
                        {steps.map((step) => (
                          <li key={step.step_id} className="mb-1">
                            {step.prompt}
                          </li>
                        ))}
                      </ol>

                      {/*
                        The list above answers "what is in this set"; this
                        answers "what will it be like to be asked it", which is
                        the question a copy actually commits to. Deliberately
                        NOT worded with "Preview": the disclosure control on
                        the row above already carries that word, and an
                        accessible name is matched as a SUBSTRING - two
                        controls in one row both answering to "Preview" is
                        ambiguous to a speech-input user and to a test.
                      */}
                      {onPreviewStudy && loaded && (
                        <button
                          type="button"
                          className="btn btn-sm btn-outline-primary mt-3"
                          onClick={() => onPreviewStudy(loaded)}
                        >
                          See this as a participant
                          <span className="visually-hidden"> {study.title}</span>
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default StudySourcePicker;
