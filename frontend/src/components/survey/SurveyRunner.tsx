import { useMemo, useState } from "react";

import type { SessionPayload, StudyStep } from "../../shared/firsthand/contract";
import {
  isAnswerable,
  isAnswered,
  validateAnswer,
  type SurveyAnswer
} from "../../lib/survey/answers";
import {
  saveParticipantResponse,
  sendRuntimeEvent
} from "../../lib/recording/runtime-client";
import { SurveyQuestion } from "./SurveyQuestion";
import "./survey.css";

/**
 * How the runner talks to the runtime.
 *
 * Injectable so the local preview harness can run the questions without a real
 * runtime session - every save there would 404, the runner would correctly
 * refuse to advance, and the preview would be unusable. Defaults to the real
 * client, so nothing that mounts this normally has to know the seam exists.
 */
export type SurveyTransport = {
  saveAnswer: typeof saveParticipantResponse;
  recordEvent: typeof sendRuntimeEvent;
};

const RUNTIME_TRANSPORT: SurveyTransport = {
  saveAnswer: saveParticipantResponse,
  recordEvent: sendRuntimeEvent
};

/**
 * The participant-facing runner for a native poll or survey.
 *
 * Deliberately NOT a mode of StudyRunner. That component is built around a
 * live recording - it holds recording status, a task window, a floating pane
 * and a stop-sharing modal, and its answers are spoken aloud rather than
 * typed. A survey records nothing and types everything, so the two share the
 * step contract and the runtime API and nothing else.
 *
 * It does reuse `lib/recording/runtime-client`, despite the directory name:
 * that module is the FirstHand runtime API client, and a survey session is an
 * ordinary runtime session writing ordinary participant_responses rows.
 * Duplicating it would mean two clients drifting apart against one endpoint.
 *
 * One question per page rather than a single long form. It matches how
 * responses are actually stored - a row per step - so each answer can be saved
 * as the participant advances and a dropped connection costs one answer rather
 * than the whole response.
 */
export function SurveyRunner({
  onComplete,
  payload,
  transport = RUNTIME_TRANSPORT
}: {
  onComplete?: () => void;
  payload: SessionPayload;
  transport?: SurveyTransport;
}) {
  const questions = useMemo(
    () => payload.steps.filter((step) => step.type !== "end"),
    [payload.steps]
  );

  /**
   * A survey exists to collect personal responses, so nothing is shown until
   * the participant has been told what happens to them and agreed. The gate is
   * a phase rather than a section further up the page: questions that are
   * merely below the fold are not gated at all.
   */
  const [phase, setPhase] = useState<
    "consent" | "questions" | "declined" | "complete"
  >("consent");
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, SurveyAnswer>>({});
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const safeIndex = Math.min(index, Math.max(questions.length - 1, 0));
  const currentStep = questions[safeIndex] as StudyStep | undefined;
  const isLast = safeIndex >= questions.length - 1;

  const answeredCount = questions.filter((step) =>
    isAnswered(step, answers[step.step_id])
  ).length;
  const answerableCount = questions.filter(isAnswerable).length;

  const recordConsent = async (accepted: boolean) => {
    setPhase(accepted ? "questions" : "declined");

    try {
      await transport.recordEvent(payload.session.session_token, {
        eventType: accepted ? "consent_accepted" : "consent_declined"
      });
    } catch {
      // The phase has already moved. Telemetry failing is not a reason to
      // strand someone on the consent screen who has just agreed, nor to keep
      // someone in a survey they have just refused.
    }
  };

  if (phase === "consent") {
    return (
      <section className="survey-runner">
        <h1>{payload.study.title}</h1>
        <p className="body-copy">{payload.study.intro_text}</p>

        <div className="survey-consent">
          <h2>Before you start</h2>
          <p className="body-copy">{payload.study.consent_text}</p>
        </div>

        <div className="actions">
          <button
            className="button button-secondary"
            onClick={() => {
              void recordConsent(false);
            }}
            type="button"
          >
            Do not agree
          </button>

          <button
            className="button"
            onClick={() => {
              void recordConsent(true);
            }}
            type="button"
          >
            Agree and start
          </button>
        </div>
      </section>
    );
  }

  // Terminal. Offering a way back would turn a refusal into a prompt to
  // reconsider, which is not consent freely given.
  if (phase === "declined") {
    return (
      <section className="survey-runner">
        <h1>No problem</h1>
        <p className="body-copy">
          You have not taken part and nothing has been recorded. You can close
          this page.
        </p>
      </section>
    );
  }

  if (phase === "complete") {
    return (
      <section className="survey-runner">
        <h1>Thank you</h1>
        <p className="body-copy">
          Your answers have been recorded. You can close this page.
        </p>
      </section>
    );
  }

  if (!currentStep) {
    return (
      <section className="survey-runner">
        <h1>{payload.study.title}</h1>
        <p className="body-copy">This survey has no questions yet.</p>
      </section>
    );
  }

  const handleChange = (answer: SurveyAnswer) => {
    setAnswers((current) => ({ ...current, [currentStep.step_id]: answer }));
    // Cleared as soon as the participant acts, so a message about the previous
    // attempt cannot sit under a field they have since corrected.
    setValidationError(null);
  };

  const handleNext = async () => {
    const answer = answers[currentStep.step_id];
    const message = validateAnswer(currentStep, answer);

    if (message) {
      setValidationError(message);
      return;
    }

    setValidationError(null);
    setSubmissionError(null);
    setIsSubmitting(true);

    try {
      // Only answered questions are persisted. Writing a row for a skipped
      // optional question would put an empty payload into the results tally
      // and make "did not answer" indistinguishable from "answered nothing".
      if (isAnswerable(currentStep) && isAnswered(currentStep, answer)) {
        await transport.saveAnswer(payload.session.session_token, {
          stepId: currentStep.step_id,
          stepType: currentStep.type,
          responsePayload: answer ?? {}
        });

        await transport.recordEvent(payload.session.session_token, {
          eventType: "response_submitted",
          stepId: currentStep.step_id
        });
      }

      if (isLast) {
        await transport.recordEvent(payload.session.session_token, {
          eventType: "session_completed"
        });

        setPhase("complete");
        onComplete?.();
        return;
      }

      setIndex(safeIndex + 1);
    } catch {
      // Deliberately not advancing: the answer is not saved, so moving on
      // would lose it silently. The participant keeps their answer on screen
      // and can retry.
      setSubmissionError(
        "We could not save your answer. Check your connection and try again."
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <section className="survey-runner">
      <h1>{payload.study.title}</h1>

      <p className="survey-progress">
        Question {safeIndex + 1} of {questions.length}
        {answerableCount > 0 ? ` - ${answeredCount} answered` : null}
      </p>

      <SurveyQuestion
        answer={answers[currentStep.step_id]}
        error={validationError}
        key={currentStep.step_id}
        onChange={handleChange}
        step={currentStep}
      />

      {submissionError ? (
        <div className="alert-banner alert-danger">
          <strong>Something went wrong at our end</strong>
          <p className="status-copy">{submissionError}</p>
        </div>
      ) : null}

      <div className="actions">
        <button
          className="button button-secondary"
          disabled={safeIndex === 0 || isSubmitting}
          onClick={() => {
            setValidationError(null);
            setIndex(safeIndex - 1);
          }}
          type="button"
        >
          Back
        </button>

        <button
          className="button"
          disabled={isSubmitting}
          onClick={() => {
            void handleNext();
          }}
          type="button"
        >
          {isSubmitting ? "Saving..." : isLast ? "Finish" : "Next"}
        </button>
      </div>
    </section>
  );
}
