import React from 'react';

/**
 * Where this opportunity's content comes from, asked as a question with two
 * answers rather than as a checkbox with an unstated default.
 *
 * The control this replaces was "Reuse an existing set of questions instead of
 * writing them here", and reuse meant a LIVE LINK: several opportunities
 * pointing at one study, so editing it changed what participants were served
 * everywhere it was used, silently. Nothing said so. A checkbox cannot state a
 * consequence, and an unticked checkbox cannot say what not ticking it means -
 * both readings looked identical to an author who had never seen the other one.
 *
 * So the choice is now explicit, both arms are named, and the consequence of
 * the second one is stated where it is taken rather than discovered later.
 * There is deliberately no third option to keep a link: offering that honestly
 * needs a version column, an approval concept and a propagation story, and
 * without them "keep linked" is a promise the product cannot keep.
 */
export type StudySourceMode = 'blank' | 'copy';

interface StudySourceChoiceProps {
  /** `question` or `task` - the thing being added, singular, lower case. */
  noun: string;
  /** Distinguishes the two tabs' radio groups and their label associations. */
  idPrefix: string;
  value: StudySourceMode;
  onChange: (value: StudySourceMode) => void;
  /** The wording for the second arm, which differs between the two surfaces. */
  copyLabel: string;
}

const StudySourceChoice: React.FC<StudySourceChoiceProps> = ({
  noun,
  idPrefix,
  value,
  onChange,
  copyLabel
}) => (
  <fieldset className="mb-4">
    <legend
      className="form-label mb-2"
      style={{ fontSize: '1rem', fontWeight: 600, float: 'none', width: 'auto' }}
    >
      How do you want to add {noun}s?
    </legend>

    <div className="form-check">
      <input
        className="form-check-input"
        type="radio"
        name={`${idPrefix}_source`}
        id={`${idPrefix}_source_blank`}
        value="blank"
        checked={value === 'blank'}
        onChange={() => onChange('blank')}
      />
      <label className="form-check-label" htmlFor={`${idPrefix}_source_blank`}>
        Create {noun}s for this study
      </label>
    </div>

    <div className="form-check">
      <input
        className="form-check-input"
        type="radio"
        name={`${idPrefix}_source`}
        id={`${idPrefix}_source_copy`}
        value="copy"
        checked={value === 'copy'}
        onChange={() => onChange('copy')}
      />
      <label className="form-check-label" htmlFor={`${idPrefix}_source_copy`}>
        {copyLabel}
      </label>
    </div>

    {/* Stated on the control, not after it is used. A copy is taken at the
        moment of choosing, so the original is never affected by what happens to
        this opportunity afterwards - and neither is this opportunity affected by
        later edits to the original.

        OUTSIDE the .form-check, deliberately. That class is `display: flex;
        align-items: center` in this project's own stylesheet, so a child here
        becomes a third flex ITEM and the sentence rendered inline beside the
        label - one very long row that read as an afterthought glued to it. The
        indent lines the text up under the label rather than under the radio:
        the input is 1.25rem wide with a `gap` of one spacing step. */}
    <div
      className="form-text"
      style={{ marginLeft: 'calc(1.25rem + var(--spacing-2))', marginTop: 0 }}
    >
      A copy is taken, so you can edit it here and the original is left alone.
    </div>
  </fieldset>
);

export default StudySourceChoice;
