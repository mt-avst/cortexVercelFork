import type { StudyStep } from "../../../shared/firsthand/contract";
import type { SurveyAnswer } from "../../../lib/survey/answers";

/**
 * Single and multi choice, sharing one component because they differ only in
 * the input type and the toggle rule.
 *
 * Rendered as real radios and checkboxes inside a fieldset whose legend is the
 * question prompt. The recorded runner's choice list uses bare labels with no
 * grouping element, which leaves the group with no accessible name - tolerable
 * when the whole page is one task, wrong in a survey where several questions
 * share a page and a screen reader user needs to know which question a set of
 * options belongs to.
 */
export function ChoiceField({
  answer,
  describedBy,
  multiple,
  onChange,
  step
}: {
  answer?: SurveyAnswer;
  describedBy?: string;
  multiple: boolean;
  onChange: (answer: SurveyAnswer) => void;
  step: StudyStep;
}) {
  const selected = multiple
    ? (answer?.selectedOptions ?? [])
    : answer?.selectedOption
      ? [answer.selectedOption]
      : [];

  const toggle = (option: string) => {
    if (!multiple) {
      onChange({ ...answer, selectedOption: option });
      return;
    }

    const next = selected.includes(option)
      ? selected.filter((value) => value !== option)
      : [...selected, option];

    onChange({ ...answer, selectedOptions: next });
  };

  return (
    <div aria-describedby={describedBy} className="choice-list">
      {(step.options ?? []).map((option) => {
        const checked = selected.includes(option);

        return (
          <label
            className={`choice-item ${checked ? "is-selected" : ""}`}
            key={option}
          >
            <input
              checked={checked}
              name={step.step_id}
              onChange={() => {
                toggle(option);
              }}
              type={multiple ? "checkbox" : "radio"}
              value={option}
            />
            <span>{option}</span>
          </label>
        );
      })}
    </div>
  );
}
