import type { StudyStep } from "@shared/firsthand/contract";
import { MAX_ANSWER_TEXT_LENGTH } from "@shared/firsthand/survey-answers";
import { isAnswerable, type SurveyAnswer } from "../../lib/survey/answers";
import { ChoiceField } from "./fields/ChoiceField";
import { ScaleField } from "./fields/ScaleField";

/**
 * One survey question: its prompt, its helper text, its field and its error.
 *
 * Choice and scale questions are wrapped in a `fieldset` whose `legend` is the
 * prompt, so the group of radios or checkboxes has an accessible name. Open
 * text uses a plain `label` bound to the textarea, because a single control
 * needs a label rather than a group.
 *
 * `instruction` renders its prompt and nothing else - it is read, not answered.
 */
export function SurveyQuestion({
  answer,
  error,
  onChange,
  step
}: {
  answer?: SurveyAnswer;
  error?: string | null;
  onChange: (answer: SurveyAnswer) => void;
  step: StudyStep;
}) {
  const helperId = step.helper_text ? `${step.step_id}-helper` : undefined;
  const errorId = error ? `${step.step_id}-error` : undefined;
  const describedBy = [helperId, errorId].filter(Boolean).join(" ") || undefined;

  const optionalHint =
    isAnswerable(step) && step.is_required === false ? (
      <p className="survey-optional-hint">Optional</p>
    ) : null;

  const helper = step.helper_text ? (
    <p className="survey-helper" id={helperId}>
      {step.helper_text}
    </p>
  ) : null;

  // Rendered whenever there is an error, and always with role="alert" beside
  // the field rather than in a page-level banner: the participant has to know
  // which of several questions on the page is the one blocking them.
  const errorNode = error ? (
    <p className="survey-error" id={errorId} role="alert">
      {error}
    </p>
  ) : null;

  if (step.type === "instruction") {
    return (
      <div className="survey-question">
        <p className="survey-prompt">{step.prompt}</p>
        {helper}
      </div>
    );
  }

  if (step.type === "open_text") {
    return (
      <div className="survey-question">
        <label className="survey-prompt" htmlFor={step.step_id}>
          {step.prompt}
        </label>
        {optionalHint}
        {helper}
        <textarea
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          className="response-input"
          id={step.step_id}
          maxLength={MAX_ANSWER_TEXT_LENGTH}
          onChange={(event) => {
            onChange({ ...answer, text: event.target.value });
          }}
          rows={6}
          value={answer?.text ?? ""}
        />
        {errorNode}
      </div>
    );
  }

  const field =
    step.type === "rating" || step.type === "nps" ? (
      <ScaleField
        answer={answer}
        describedBy={describedBy}
        onChange={onChange}
        step={step}
      />
    ) : (
      <ChoiceField
        answer={answer}
        describedBy={describedBy}
        multiple={step.type === "multi_choice"}
        onChange={onChange}
        step={step}
      />
    );

  return (
    <fieldset className="survey-question">
      <legend className="survey-prompt">{step.prompt}</legend>
      {optionalHint}
      {helper}
      {field}
      {errorNode}
    </fieldset>
  );
}
