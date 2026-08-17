import {
  NPS_SCALE_MAX,
  type StudyStep
} from "../../../shared/firsthand/contract";
import type { SurveyAnswer } from "../../../lib/survey/answers";

/**
 * Rating and NPS, as a radio group rather than a slider or a row of buttons.
 *
 * A slider gives no discrete accessible value per point, starts at a value the
 * participant never chose, and is hostile on touch. A radio group is arrow-key
 * navigable, announces "3 of 5", and cannot report an answer nobody gave.
 *
 * The two differ in more than their range. NPS starts at 0 because zero is a
 * real score; a rating starts at 1 because zero would be an unanswered
 * question masquerading as the lowest score. NPS's range is fixed by the
 * contract and never read from config.
 */
export function ScaleField({
  answer,
  describedBy,
  onChange,
  step
}: {
  answer?: SurveyAnswer;
  describedBy?: string;
  onChange: (answer: SurveyAnswer) => void;
  step: StudyStep;
}) {
  const isNps = step.type === "nps";
  const min = isNps ? 0 : 1;
  const max = isNps ? NPS_SCALE_MAX : (step.config?.scale_max ?? 0);
  const points = Array.from({ length: max - min + 1 }, (_, index) => min + index);

  const minLabel = isNps ? "Not at all likely" : step.config?.min_label;
  const maxLabel = isNps ? "Extremely likely" : step.config?.max_label;

  return (
    <div aria-describedby={describedBy} className="scale-field">
      <div className="scale-points">
        {points.map((point) => {
          const checked = answer?.rating === point;

          return (
            <label
              className={`scale-point ${checked ? "is-selected" : ""}`}
              key={point}
            >
              <input
                checked={checked}
                name={step.step_id}
                onChange={() => {
                  onChange({ ...answer, rating: point });
                }}
                type="radio"
                value={point}
              />
              <span>{point}</span>
            </label>
          );
        })}
      </div>

      {/*
        The poles are NOT aria-hidden, and must not become so.

        Each radio's accessible name is its bare number, so hiding the poles
        leaves a screen reader user choosing between "1" and "5" with nothing
        to say which end is good. They are also not attached with aria-label,
        which would replace the visible number rather than add to it - the trap
        that silently hid a deadline on the browse card.

        Instead the pole text is spelled out once, in reading order right after
        the group, in the "1 = Very hard" form that carries its own context.
      */}
      {minLabel || maxLabel ? (
        <div className="scale-labels">
          <span>{minLabel ? `${min} = ${minLabel}` : ""}</span>
          <span>{maxLabel ? `${max} = ${maxLabel}` : ""}</span>
        </div>
      ) : null}
    </div>
  );
}
