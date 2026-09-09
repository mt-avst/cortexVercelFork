import React from 'react';

interface StudyProvenanceNoteProps {
  /** The source's title, or null when it could no longer be resolved. */
  title: string | null;
  /** ISO date the copy was taken; today's date on a copy not yet saved. */
  copiedAt?: string;
  /** `question` / `task`, singular, lower case. */
  noun: string;
  /** Offered only while the choice can still be remade. */
  onChooseAnother?: () => void;
}

const formatDate = (value?: string): string | null => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
};

/**
 * Says where this content came from, and - the part the checkbox never said -
 * that the two have been separate ever since.
 *
 * Rendered from `copied_from_study_id`, which is stored on the study, so it
 * survives the page and answers the question for whoever opens the opportunity
 * next rather than only for the author who took the copy.
 *
 * The source's title is resolved by a lookup that can fail: a source can be
 * deleted, and there is deliberately no foreign key stopping that. A missing
 * title degrades to "another set" rather than hiding the note, because the fact
 * that this content was copied is true whether or not its source still exists.
 */
const StudyProvenanceNote: React.FC<StudyProvenanceNoteProps> = ({
  title,
  copiedAt,
  noun,
  onChooseAnother
}) => {
  const when = formatDate(copiedAt);

  return (
    <div className="alert alert-info py-2 px-3 mb-4" style={{ fontSize: '0.875rem' }}>
      <div>
        Copied from{' '}
        {title ? <strong>{title}</strong> : <span>a set that no longer exists</span>}
        {when ? ` on ${when}` : ''}. Later changes to the original will not affect
        this study, and changes you make here will not affect the original.
      </div>
      {onChooseAnother && (
        <button
          type="button"
          className="btn btn-sm btn-link p-0 mt-1"
          onClick={onChooseAnother}
        >
          Choose a different set of {noun}s
        </button>
      )}
    </div>
  );
};

export default StudyProvenanceNote;
