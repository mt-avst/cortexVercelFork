import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { SessionPayload, StudyStep } from "../../shared/firsthand/contract";
import { describeTarget } from "../../lib/recording/task-target";
import {
  clearParticipantSessionStorage,
  getRunnerStorageKey
} from "../../lib/recording/session-local-state";
import {
  saveParticipantResponse,
  sendRuntimeEvent
} from "../../lib/recording/runtime-client";
import type { RuntimeEventType } from "../../lib/recording/runtime-events";
import { Modal } from "./Modal";

type StudyRunnerProps = {
  attemptNumber: number;
  captureStoppedExternally: boolean;
  microphonePermission:
    | "not_requested"
    | "requesting"
    | "granted"
    | "denied"
    | "cancelled"
    | "unavailable";
  payload: SessionPayload;
  recordingStartedAt: number | null;
  recordingStatus:
    | "not_started"
    | "starting"
    | "active"
    | "stopping"
    | "stopped"
    | "failed";
  screenPermission:
    | "not_requested"
    | "requesting"
    | "granted"
    | "denied"
    | "cancelled"
    | "unavailable";
  onComplete: (input: {
    completedAt: string;
    responsesCount: number;
  }) => Promise<void> | void;
  // Opens (or brings back to the front) the separate window the participant is
  // recording. Returns false only when a pop-up block stopped it.
  onOpenTaskWindow: (url: string) => boolean;
  // The floating task pane is owned by the session flow, which opens it as
  // recording starts. The runner only renders into it, takes it down when the
  // session ends, and offers the way back if the participant closes it.
  onCloseTaskPip: () => void;
  onOpenTaskPip: () => Promise<boolean>;
  pipSupported: boolean;
  pipWindow: Window | null;
};

type StoredResponseMap = Record<
  string,
  {
    text?: string;
    selectedOption?: string;
  }
>;

type RunnerPersistence = {
  currentStepIndex: number;
  responses: StoredResponseMap;
  startedAt: string | null;
  completedAt: string | null;
};

export function StudyRunner({
  attemptNumber,
  captureStoppedExternally,
  microphonePermission,
  payload,
  recordingStartedAt,
  recordingStatus,
  screenPermission,
  onComplete,
  onCloseTaskPip,
  onOpenTaskPip,
  onOpenTaskWindow,
  pipSupported,
  pipWindow
}: StudyRunnerProps) {
  const storageKey = getRunnerStorageKey(payload.session.session_token, attemptNumber);
  const [currentTaskIndex, setCurrentTaskIndex] = useState(0);
  const [responses, setResponses] = useState<StoredResponseMap>({});
  // Not shown anywhere: this is the bootstrap guard. While null the runtime
  // has not been started for this attempt; once set (and persisted) a page
  // refresh must not re-fire session_started.
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [completedAt, setCompletedAt] = useState<string | null>(null);
  const [isHydrated, setIsHydrated] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Two separate channels. A missing answer is the participant's to fix and
  // belongs beside the input; a save failure is ours and belongs in an alert.
  // They shared one channel and one hardcoded "We hit a save issue." heading,
  // so leaving a required question blank accused the system of breaking.
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isReturnModalDismissed, setIsReturnModalDismissed] = useState(false);
  const hasAutoCompletedRef = useRef(false);
  const runnerShellRef = useRef<HTMLDivElement | null>(null);

  // The end step is a completion marker, not a task: it is never rendered and
  // never fires step events. Everything below - indexes, persistence, events,
  // the task counter - runs over taskSteps only.
  const taskSteps = useMemo(
    () => payload.steps.filter((step) => step.type !== "end"),
    [payload.steps]
  );
  const lastTaskIndex = Math.max(taskSteps.length - 1, 0);
  const safeTaskIndex = Math.min(Math.max(currentTaskIndex, 0), lastTaskIndex);
  const currentStep: StudyStep | undefined = taskSteps[safeTaskIndex];
  const responseCount = Object.values(responses).filter(
    (response) => Boolean(response.text?.trim()) || Boolean(response.selectedOption)
  ).length;
  const currentTargetUrl = currentStep?.target_url ?? null;
  const isAnswerable =
    currentStep?.type === "open_text" || currentStep?.type === "single_choice";
  const shouldShowReturnModal =
    captureStoppedExternally &&
    recordingStatus === "stopped" &&
    !completedAt &&
    !isReturnModalDismissed;

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(storageKey);

      if (saved) {
        const parsed = JSON.parse(saved) as Partial<RunnerPersistence>;
        // Stale persistence from before the end step was excluded (or from an
        // edited study) can hold an index past the last task. Clamp, never trust.
        const persistedIndex = parsed.currentStepIndex ?? 0;
        const maxIndex = Math.max(taskSteps.length - 1, 0);

        setCurrentTaskIndex(Math.min(Math.max(persistedIndex, 0), maxIndex));
        setResponses(parsed.responses ?? {});
        setStartedAt(parsed.startedAt ?? null);
        setCompletedAt(parsed.completedAt ?? null);
      }
    } catch {
      window.localStorage.removeItem(storageKey);
    } finally {
      setIsHydrated(true);
    }
  }, [storageKey, taskSteps]);

  useEffect(() => {
    if (!isHydrated) {
      return;
    }

    const persistence: RunnerPersistence = {
      currentStepIndex: currentTaskIndex,
      responses,
      startedAt,
      completedAt
    };

    window.localStorage.setItem(storageKey, JSON.stringify(persistence));
  }, [
    completedAt,
    currentTaskIndex,
    isHydrated,
    responses,
    startedAt,
    storageKey
  ]);

  useEffect(() => {
    if (!isHydrated || startedAt) {
      return;
    }

    const now = new Date().toISOString();

    setStartedAt(now);

    void bootstrapRuntime(payload, attemptNumber, currentStep, now).catch(() => {
      setSubmissionError(
        "We could not initialise the study runtime. Refresh the page and retry."
      );
    });
  }, [attemptNumber, currentStep, isHydrated, payload, startedAt]);

  useEffect(() => {
    if (!isHydrated) {
      return;
    }

    // Advancing a task swaps the prompt, the task workspace and the response
    // input. The runner is embedded mid-page in the accordion, so resetting
    // the whole document to the top would scroll past everything the
    // participant already did - only this section needs to come back into
    // view, at its own top.
    runnerShellRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [currentTaskIndex, isHydrated]);

  useEffect(() => {
    if (!captureStoppedExternally || recordingStatus !== "stopped") {
      setIsReturnModalDismissed(false);
    }
  }, [captureStoppedExternally, recordingStatus]);

  // The pane must not outlive the task phase by ANY route, not just the tidy
  // one. Completion calls onCloseTaskPip explicitly, but an interrupted run
  // unwinds by unmounting this component straight back to setup - and the hook
  // that owns the pane lives in the parent, which stays mounted. Without this,
  // that path leaves an empty always-on-top window covering the recovery
  // message the participant is supposed to read.
  useEffect(() => onCloseTaskPip, [onCloseTaskPip]);

  // Defensive: the schema guarantees at least one step but not at least one
  // task. A payload of only an end step has nothing to run, so complete
  // immediately instead of rendering an empty task shell.
  useEffect(() => {
    if (
      !isHydrated ||
      !startedAt ||
      taskSteps.length > 0 ||
      completedAt ||
      hasAutoCompletedRef.current
    ) {
      return;
    }

    hasAutoCompletedRef.current = true;
    void finishSession().catch(() => {
      setSubmissionError(
        "We could not finish the session yet. Please try again."
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completedAt, isHydrated, startedAt, taskSteps.length]);

  function handleTextChange(step: StudyStep, text: string) {
    setValidationError(null);
    setResponses((currentResponses) => ({
      ...currentResponses,
      [step.step_id]: {
        text
      }
    }));
  }

  function handleChooseOption(step: StudyStep, option: string) {
    setValidationError(null);
    setResponses((currentResponses) => ({
      ...currentResponses,
      [step.step_id]: {
        selectedOption: option
      }
    }));
  }

  if (!isHydrated) {
    return (
      <div className="runner-shell">
        <div className="alert-banner alert-neutral">
          <strong>Preparing your session…</strong>
        </div>
      </div>
    );
  }

  async function finishSession() {
    // The pane is taken down AFTER the session is actually finished, never
    // before. Closing it first meant a failed completion request made the
    // participant's tasks window vanish while the only error message rendered
    // in the tab behind the page they were working in - so from where they
    // sat, the study simply disappeared.
    await sendRuntimeEvent(payload.session.session_token, {
      attemptNumber,
      eventType: "session_completed"
    });

    const now = new Date().toISOString();

    setCompletedAt(now);
    await onComplete({
      completedAt: now,
      responsesCount: responseCount
    });
    // The floating pane belongs to the running study; the upload and done
    // sections happen back in this tab.
    onCloseTaskPip();
    clearParticipantSessionStorage(
      window.localStorage,
      payload.session.session_token,
      "runner",
      attemptNumber
    );
  }

  async function handleCompleteTask() {
    if (!currentStep || completedAt) {
      return;
    }

    const validationMessage = validateStepResponse(currentStep, responses[currentStep.step_id]);

    if (validationMessage) {
      setValidationError(validationMessage);
      return;
    }

    const isLastTask = safeTaskIndex >= taskSteps.length - 1;

    setValidationError(null);
    setSubmissionError(null);
    setIsSubmitting(true);

    try {
      const activeResponse = responses[currentStep.step_id];

      if (shouldPersistResponse(currentStep, activeResponse)) {
        await saveParticipantResponse(payload.session.session_token, {
          attemptNumber,
          stepId: currentStep.step_id,
          stepType: currentStep.type,
          responsePayload: activeResponse ?? {}
        });

        await sendRuntimeEvent(payload.session.session_token, {
          attemptNumber,
          eventType: "response_submitted",
          stepId: currentStep.step_id
        });
      }

      await sendRuntimeEvent(payload.session.session_token, {
        attemptNumber,
        eventType: "step_exited",
        stepId: currentStep.step_id
      });

      if (!isLastTask) {
        const nextTask = taskSteps[safeTaskIndex + 1];

        await sendRuntimeEvent(payload.session.session_token, {
          attemptNumber,
          eventType: "step_entered",
          stepId: nextTask.step_id,
          metadata: {
            order: nextTask.order
          }
        });
        setCurrentTaskIndex(safeTaskIndex + 1);
      } else {
        await finishSession();
      }
    } catch {
      setSubmissionError(
        isLastTask
          ? "We could not finish the session yet. Please try again."
          : "We could not save your answer. Please try again."
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  if (!currentStep) {
    // No tasks to run: the effect above completes the session. Show only the
    // system-fault banner if that completion fails; never an empty task shell.
    return (
      <div className="runner-shell">
        {submissionError ? (
          <div className="alert-banner alert-danger">
            <strong>Something went wrong at our end</strong>
            <p className="status-copy">{submissionError}</p>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="runner-shell" ref={runnerShellRef}>
      {/* Spec 3.4: the recording banner is persistent at the top of the task
          state, above the task instruction. */}
      <div className={`recording-callout recording-callout--compact is-${recordingStatus}`}>
        <strong className="recording-callout-title">
          {recordingStatus === "active" ? (
            <span aria-hidden="true" className="recording-dot" />
          ) : null}
          {getRecordingCalloutTitle(recordingStatus)}
        </strong>
        <div className="recording-callout-meta recording-callout-meta--compact">
          <span className={getCaptureStatusChipClass(microphonePermission)}>
            {getCaptureStatusChipLabel("Mic", microphonePermission)}
          </span>
          <span className={getCaptureStatusChipClass(screenPermission)}>
            {getCaptureStatusChipLabel("Screen", screenPermission)}
          </span>
          <span className="chip">
            Started {recordingStartedAt === null ? "--:--" : formatStartedTime(recordingStartedAt)}
          </span>
        </div>
      </div>

      <div className="runner-header runner-header--lean">
        {taskSteps.length > 1 ? (
          <p className="status-copy">
            Task {safeTaskIndex + 1} of {taskSteps.length}
          </p>
        ) : null}
        <h1>{currentStep.prompt}</h1>
      </div>

      {currentTargetUrl ? (
        <TaskWindowPanel
          onReopen={onOpenTaskPip}
          onOpen={onOpenTaskWindow}
          pipOpen={Boolean(pipWindow)}
          pipSupported={pipSupported}
          recordingActive={recordingStatus === "active"}
          targetUrl={currentTargetUrl}
        />
      ) : null}

      <article className="runner-card runner-card--instruction">
        {currentStep.helper_text ? (
          <p className="runner-instruction-hint">{currentStep.helper_text}</p>
        ) : currentStep.type === "instruction" ? (
          <p className="runner-instruction-hint">
            Do the task in the task window, then confirm below.
          </p>
        ) : (
          <p className="runner-instruction-hint">
            Type your answer below. It is saved with this step.
          </p>
        )}

        {/* Independent of the helper-text branch above: authored steps
            usually carry helper_text, which would otherwise hide this. */}
        {isAnswerable && currentStep.is_required === false ? (
          <p className="runner-optional-hint">This one is optional.</p>
        ) : null}

        {currentStep.type === "instruction" ? (
          <div className="alert-banner alert-neutral alert-banner--inline">
            <strong>Use the button below once you have finished the task</strong>
          </div>
        ) : null}

        <TaskResponseFields
          onChooseOption={(option) => handleChooseOption(currentStep, option)}
          onTextChange={(text) => handleTextChange(currentStep, text)}
          response={responses[currentStep.step_id]}
          step={currentStep}
        />

        {validationError ? (
          // Beside the input the participant needs to act on, not in the
          // system-fault banner at the foot of the page.
          <p className="response-validation" role="alert">
            {validationError}
          </p>
        ) : null}
      </article>

      {submissionError ? (
        <div className="alert-banner alert-danger">
          <strong>Something went wrong at our end</strong>
          <p className="status-copy">{submissionError}</p>
        </div>
      ) : null}

      <div className="actions">
        <button
          className="button"
          disabled={isSubmitting || Boolean(completedAt)}
          onClick={() => {
            void handleCompleteTask();
          }}
          type="button"
        >
          {isSubmitting ? "Saving..." : "I’ve completed this task"}
        </button>
      </div>

      {pipWindow
        ? createPortal(
            <PipTaskCard
              completedAt={completedAt}
              count={taskSteps.length}
              index={safeTaskIndex}
              isSubmitting={isSubmitting}
              onChooseOption={(option) => handleChooseOption(currentStep, option)}
              onComplete={() => {
                void handleCompleteTask();
              }}
              onTextChange={(text) => handleTextChange(currentStep, text)}
              recordingActive={recordingStatus === "active"}
              response={responses[currentStep.step_id]}
              step={currentStep}
              studyTitle={payload.study.title}
              validationError={validationError}
            />,
            pipWindow.document.body
          )
        : null}

      {shouldShowReturnModal ? (
        <Modal
          onDismiss={() => {
            setIsReturnModalDismissed(true);
          }}
        >
          <p className="eyebrow">Screen sharing stopped</p>
          <h2>Your recording has stopped</h2>
          <p className="body-copy">
            You stopped sharing your screen, so the recording has ended. It is
            safe and will be uploaded automatically after you finish - nothing
            extra is needed from you for it.
          </p>
          <p className="body-copy">
            Your answers to the remaining tasks are still saved, so continue
            through them to finish the session.
          </p>

          <div className="actions fh-modal-actions">
            <button
              className="button"
              onClick={() => {
                setIsReturnModalDismissed(true);
              }}
              type="button"
            >
              Continue with the tasks
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function validateStepResponse(
  step: StudyStep,
  response: StoredResponseMap[string] | undefined
) {
  if (!step.is_required) {
    return null;
  }

  if (step.type === "open_text" && !response?.text?.trim()) {
    return "Please enter a response before continuing.";
  }

  if (step.type === "single_choice" && !response?.selectedOption) {
    return "Please choose one option before continuing.";
  }

  return null;
}

function getRecordingCalloutTitle(recordingStatus: StudyRunnerProps["recordingStatus"]) {
  switch (recordingStatus) {
    case "active":
      return "Recording is live";
    case "starting":
      return "Waiting for screen-share and microphone permissions";
    case "stopping":
      return "Stopping recording";
    case "stopped":
      return "Recording captured";
    case "failed":
      return "Recording needs attention";
    case "not_started":
    default:
      return "Recording has not started";
  }
}

function shouldPersistResponse(
  step: StudyStep,
  response: StoredResponseMap[string] | undefined
) {
  if (!response) {
    return false;
  }

  if (step.type === "open_text") {
    return Boolean(response.text?.trim());
  }

  if (step.type === "single_choice") {
    return Boolean(response.selectedOption);
  }

  return false;
}

async function bootstrapRuntime(
  payload: SessionPayload,
  attemptNumber: number,
  currentStep: StudyStep | undefined,
  startedAt: string
) {
  const events: Array<{
    eventType: RuntimeEventType;
    stepId?: string;
    metadata?: Record<string, unknown>;
  }> = [
    { eventType: "session_started", metadata: { source: "study_runner", startedAt } }
  ];

  // Only a task can be entered. A payload with no task steps starts the
  // session and completes it elsewhere without any step events.
  if (currentStep) {
    events.push({
      eventType: "step_entered",
      stepId: currentStep.step_id,
      metadata: {
        order: currentStep.order
      }
    });
  }

  await postEventSequence(payload.session.session_token, attemptNumber, events);
}

async function postEventSequence(
  token: string,
  attemptNumber: number,
  events: Array<{
    eventType: RuntimeEventType;
    stepId?: string;
    metadata?: Record<string, unknown>;
  }>
) {
  for (const event of events) {
    await sendRuntimeEvent(token, {
      attemptNumber,
      ...event
    });
  }
}

function formatStartedTime(epochMs: number) {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(new Date(epochMs));
}

/**
 * The task happens in a separate window the participant opened and is
 * recording, not in an embedded frame. This panel points them at that window,
 * brings it back to the front on demand, and (for a later task on a different
 * page) navigates it there. The iframe it replaced could not show any real
 * third-party product: those set X-Frame-Options / frame-ancestors and render
 * blank, which is exactly why the flow now records a real window instead.
 */
function TaskWindowPanel({
  onOpen,
  onReopen,
  pipOpen,
  pipSupported,
  recordingActive,
  targetUrl
}: {
  onOpen: (url: string) => boolean;
  onReopen: () => Promise<boolean>;
  pipOpen: boolean;
  pipSupported: boolean;
  recordingActive: boolean;
  targetUrl: string;
}) {
  const { label } = describeTarget(targetUrl);
  const [blocked, setBlocked] = useState(false);
  const [reopenFailed, setReopenFailed] = useState(false);

  return (
    <section className="task-window-panel" aria-label="Task page">
      <div className="task-window-head">
        <p className="eyebrow task-window-eyebrow">Your task page</p>
        <button
          className="button secondary task-window-open"
          onClick={() => {
            setBlocked(!onOpen(targetUrl));
          }}
          type="button"
        >
          Go to the task page
        </button>
      </div>

      <p className="task-window-copy">
        Your task is in the separate window showing {label}. Do the task there,
        then come back here and confirm below.
      </p>

      {/*
        Recovery only. The pane is opened for the participant as recording
        starts, so this is the way BACK after they close it - not the way in.
        Hidden while it is up, because a control that reopens something already
        open reads as broken.
      */}
      {pipSupported && !pipOpen ? (
        <button
          className="button secondary task-window-float"
          onClick={() => {
            void onReopen().then((opened) => {
              setReopenFailed(!opened);
            });
          }}
          type="button"
        >
          Keep tasks on top
        </button>
      ) : null}

      {pipOpen ? (
        <p className="task-window-copy">
          Your tasks are in the small window on top. Close that window to bring
          them back here.
        </p>
      ) : null}

      {reopenFailed && !pipOpen ? (
        <div className="alert-banner alert-danger">
          <strong>That window would not open</strong>
          <p className="status-copy">
            You can keep using the tasks below instead.
          </p>
        </div>
      ) : null}

      {/*
        Deliberately conditional in wording rather than in code. Only the
        shared surface's video track ending stops a recording, so closing the
        task window stops it only when that window is what was shared - and
        whole-screen sharing is the fallback this flow actively suggests. The
        surface is knowable (session-recorder reads displaySurface off the
        track settings) but not dependable: Firefox is a supported browser and
        does not report it at all, and surfaceSwitching lets the participant
        change the shared surface mid-session, after the one read. Copy that
        must never be wrong cannot be gated on that.
      */}
      {recordingActive ? (
        <p className="task-window-note">
          Keep the task window open until you finish. If you shared that window
          rather than your whole screen, closing it ends the recording.
        </p>
      ) : null}

      {blocked ? (
        <div className="alert-banner alert-danger">
          <strong>The task window would not open</strong>
          <p className="status-copy">
            Allow pop-ups for this site, then use “Go to the task page” again.
          </p>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The response inputs, shared by the in-page task card and the floating PiP
 * pane so there is exactly one implementation of each input type. Both render
 * the same controlled state; whichever surface the participant types into,
 * the other reflects it.
 */
function TaskResponseFields({
  onChooseOption,
  onTextChange,
  response,
  step
}: {
  onChooseOption: (option: string) => void;
  onTextChange: (text: string) => void;
  response: { text?: string; selectedOption?: string } | undefined;
  step: StudyStep;
}) {
  return (
    <>
      {step.type === "open_text" ? (
        <textarea
          className="response-input"
          onChange={(event) => {
            onTextChange(event.target.value);
          }}
          placeholder="Type your response here"
          rows={7}
          value={response?.text ?? ""}
        />
      ) : null}

      {step.type === "single_choice" ? (
        <div className="choice-list">
          {step.options?.map((option) => {
            const checked = response?.selectedOption === option;

            return (
              <label className={`choice-item ${checked ? "is-selected" : ""}`} key={option}>
                <input
                  checked={checked}
                  name={step.step_id}
                  onChange={() => {
                    onChooseOption(option);
                  }}
                  type="radio"
                  value={option}
                />
                <span>{option}</span>
              </label>
            );
          })}
        </div>
      ) : null}
    </>
  );
}

/**
 * The whole current task, rendered into the floating Document PiP window so
 * the participant can read the prompt and answer without leaving the page
 * under test. Same state and same completion handler as the in-page card -
 * this is a second view of the task, never a second copy of the logic.
 */
function PipTaskCard({
  completedAt,
  count,
  index,
  isSubmitting,
  onChooseOption,
  onComplete,
  onTextChange,
  recordingActive,
  response,
  step,
  studyTitle,
  validationError
}: {
  completedAt: string | null;
  count: number;
  index: number;
  isSubmitting: boolean;
  onChooseOption: (option: string) => void;
  onComplete: () => void;
  onTextChange: (text: string) => void;
  recordingActive: boolean;
  response: { text?: string; selectedOption?: string } | undefined;
  step: StudyStep;
  studyTitle: string;
  validationError: string | null;
}) {
  const isAnswerable = step.type === "open_text" || step.type === "single_choice";

  return (
    <section aria-label="Floating task panel" className="pip-card">
      {/*
        A NON-AUTHORABLE header, and it is a security control rather than
        decoration. This window has no browser chrome, no nav and no study
        context, and the prompt below is researcher-authored text rendered as
        its only heading - so without this, a one-step study is a bare window
        containing an attacker's sentence, a text input and a button, floating
        above every application and attributed by the OS to Cortex. That is a
        credible surface for "re-enter your SSO password to continue", whose
        answer would be stored as a study response and typed into the recording.
        Everything in this strip comes from Cortex or from recorder state; none
        of it can be authored.
      */}
      <header className="pip-trust">
        <span className="pip-trust-brand">Cortex</span>
        <span className={`pip-trust-rec is-${recordingActive ? "live" : "stopped"}`}>
          {recordingActive ? (
            <>
              <span aria-hidden="true" className="recording-dot" />
              Recording
            </>
          ) : (
            "Not recording"
          )}
        </span>
      </header>
      <p className="pip-trust-study">{studyTitle}</p>

      {/*
        The whole point of this pane is that the participant stops looking at
        the Cortex tab - which is exactly where the "your recording stopped"
        modal renders. Without this they could answer their way through an
        entire study that captured nothing.
      */}
      {!recordingActive ? (
        <div className="alert-banner alert-danger" role="alert">
          <strong>Recording has stopped</strong>
          <p className="status-copy">
            Go back to the Cortex tab to see what happened. Nothing you do here
            is being recorded.
          </p>
        </div>
      ) : null}

      {count > 1 ? (
        <p className="status-copy pip-counter">
          Task {index + 1} of {count}
        </p>
      ) : null}

      <h1 className="pip-prompt">{step.prompt}</h1>

      {step.helper_text ? (
        <p className="runner-instruction-hint">{step.helper_text}</p>
      ) : null}

      {isAnswerable && step.is_required === false ? (
        <p className="runner-optional-hint">This one is optional.</p>
      ) : null}

      <TaskResponseFields
        onChooseOption={onChooseOption}
        onTextChange={onTextChange}
        response={response}
        step={step}
      />

      {validationError ? (
        <p className="response-validation" role="alert">
          {validationError}
        </p>
      ) : null}

      <button
        className="button pip-complete"
        // Matches the in-page control exactly. The two are meant to be one
        // button in two places; divergence here is how they drift apart.
        disabled={isSubmitting || Boolean(completedAt)}
        onClick={onComplete}
        type="button"
      >
        {isSubmitting ? "Saving..." : "I’ve completed this task"}
      </button>
    </section>
  );
}

/**
 * Neutral permission states stay grey; only genuine denial or a missing
 * device earns the warm chip treatment (AC13).
 */
function getCaptureStatusChipClass(
  permission: StudyRunnerProps["microphonePermission"]
) {
  if (permission === "denied" || permission === "unavailable") {
    return "chip chip--danger";
  }

  // A granted track reads as the prototype's red-bordered "mic live" /
  // "screen live" tag while the banner is up.
  return permission === "granted" ? "chip chip--live" : "chip";
}

function getCaptureStatusChipLabel(
  label: "Mic" | "Screen",
  permission: StudyRunnerProps["microphonePermission"]
) {
  switch (permission) {
    case "granted":
      return `${label} live`;
    case "requesting":
      return `${label} awaiting permission`;
    case "denied":
      return `${label} blocked`;
    case "cancelled":
      return `${label} cancelled`;
    case "unavailable":
      return `${label} unavailable`;
    case "not_requested":
    default:
      return `${label} not requested`;
  }
}
