import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";

import type { SessionPayload } from "@shared/firsthand/contract";
import {
  assessDeviceSupport,
  collectDeviceSnapshot,
  type DeviceSnapshot,
  type DeviceSupport
} from "../../lib/recording/device-support";
import { formatFileSize } from "../../lib/recording/file-size";
import { buildParticipantReturnUrl } from "../../lib/recording/participant-return";
import {
  clearParticipantSessionStorage,
  getFlowStorageKey,
  getInterruptedRunRecovery,
  migratePersistedPhase,
  type FlowPhase
} from "../../lib/recording/session-local-state";
import {
  shouldGuardNavigation,
  useSessionRecorder
} from "../../lib/recording/session-recorder";
import { describeTarget, getPrimaryTargetUrl } from "../../lib/recording/task-target";
import { useTaskWindow, type TaskWindowStatus } from "../../lib/recording/task-window";
import { useTaskPip } from "../../lib/recording/task-pip";
import {
  type DirectRecordingUploadMode,
  sendRuntimeEvent
} from "../../lib/recording/runtime-client";
import {
  assessSetupReadiness,
  collectSetupSnapshot,
  type SetupAssessment,
  type SetupCheck,
  type SetupCheckId
} from "../../lib/recording/setup-checks";
import { PipStandbyCard } from "./PipStandbyCard";
import { StudyRunner } from "./StudyRunner";

type ParticipantSessionFlowProps = {
  attemptNumber: number;
  directRecordingUploadMode: DirectRecordingUploadMode;
  forceReset?: boolean;
  payload: SessionPayload;
  token: string;
};

type SetupRunState = "idle" | "running" | "complete";

type RecorderState = ReturnType<typeof useSessionRecorder>["state"];

type UploadedAsset = {
  relativePath: string;
  fileSizeBytes: number;
  mimeType: string;
};

type CompletionSummary = {
  completedAt: string;
  responsesCount: number;
  uploadedAsset: UploadedAsset | null;
};

// Section indexes: Welcome 0, Consent 1, Setup 2, Task 3, Upload 4, Done 5.
// Declined is terminal off consent, so it holds the consent position.
const phaseStepIndex: Record<FlowPhase, number> = {
  welcome: 0,
  consent: 1,
  setup: 2,
  running: 3,
  uploading: 4,
  completed: 5,
  declined: 1
};

type SectionStatus = "locked" | "current" | "done" | "ended";

const FLOW_SECTION_LABELS = [
  "Welcome",
  "Consent",
  "Setup and start",
  "Task",
  "Upload",
  "Done"
] as const;

// The page is one continuous scroll, not a series of full-screen swaps: every
// section stays mounted, and its own progress determines whether it is
// locked (not reached yet), current (the active, interactive section) or
// done (passed, kept visible in a read-only form so the participant can see
// what they already did - matching the prototype's always-expanded blocks).
function getSectionStatus(index: number, phase: FlowPhase): SectionStatus {
  if (phase === "declined") {
    if (index === 0) {
      return "done";
    }

    // Declining replaces the consent section's own content; nothing after it
    // ever unlocks.
    return index === 1 ? "ended" : "locked";
  }

  const currentIndex = phaseStepIndex[phase];

  if (index < currentIndex) {
    return "done";
  }

  return index === currentIndex ? "current" : "locked";
}

export function ParticipantSessionFlow({
  attemptNumber,
  directRecordingUploadMode,
  forceReset = false,
  payload,
  token
}: ParticipantSessionFlowProps) {
  const storageKey = getFlowStorageKey(token, attemptNumber);
  const [phase, setPhase] = useState<FlowPhase>("welcome");
  const [setupRunState, setSetupRunState] = useState<SetupRunState>("idle");
  const [assessment, setAssessment] = useState<SetupAssessment | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);
  const [completionSummary, setCompletionSummary] =
    useState<CompletionSummary | null>(null);
  const [isHydrated, setIsHydrated] = useState(false);
  const [deviceSnapshot, setDeviceSnapshot] = useState<DeviceSnapshot | null>(
    null
  );
  // Guards the auto-run against effect re-fires within one visit to the setup
  // phase, while still re-running the checks on every fresh arrival.
  const setupAutoRunRef = useRef(false);
  const recorder = useSessionRecorder(token, {
    attemptNumber,
    directRecordingUploadMode
  });
  const taskWindow = useTaskWindow();
  // Owned here rather than in StudyRunner because the pane is opened from the
  // start handler below, while the runner has not mounted yet.
  const taskPip = useTaskPip();
  const sectionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const hasScrolledOnMountRef = useRef(false);

  useEffect(() => {
    try {
      if (forceReset) {
        clearParticipantSessionStorage(window.localStorage, token, "all", attemptNumber);
      }

      const saved = forceReset ? null : window.localStorage.getItem(storageKey);

      if (saved) {
        const parsed = JSON.parse(saved) as Partial<{ phase: string }>;

        if (typeof parsed.phase === "string") {
          // Assessment is deliberately not restored: checks auto-run on every
          // arrival at setup, so a stale persisted result would be wrong.
          setPhase(migratePersistedPhase(parsed.phase));
        }
      } else {
        clearParticipantSessionStorage(window.localStorage, token, "runner", attemptNumber);
      }
    } catch {
      clearParticipantSessionStorage(window.localStorage, token, "all", attemptNumber);
    } finally {
      setIsHydrated(true);
    }

    if (forceReset) {
      const nextUrl = new URL(window.location.href);

      nextUrl.searchParams.delete("fresh");
      nextUrl.searchParams.delete("reset");
      window.history.replaceState({}, "", nextUrl.toString());
    }
  }, [attemptNumber, forceReset, storageKey, token]);

  useEffect(() => {
    if (!isHydrated) {
      return;
    }

    // A persisted "uploading" phase is only resumable because the recovery
    // effect below resets it to setup on the next load: after a reload the
    // recording chunks are gone, so there is nothing left to upload.
    window.localStorage.setItem(storageKey, JSON.stringify({ phase }));
  }, [isHydrated, phase, storageKey]);

  useEffect(() => {
    if (!isHydrated) {
      return;
    }

    const recovery = getInterruptedRunRecovery({
      phase,
      recordingStatus: recorder.state.recordingStatus
    });

    if (!recovery) {
      return;
    }

    clearParticipantSessionStorage(window.localStorage, token, "runner", attemptNumber);
    setRecoveryMessage(recovery.message);
    setPhase(recovery.nextPhase);

    void sendRuntimeEvent(token, {
      attemptNumber,
      eventType: recovery.runtimeEventType,
      metadata: {
        source: "participant_session_flow_recovery"
      }
    }).catch(() => {
      setRecoveryMessage(
        "Your last attempt was interrupted, so we have reset it. You can start again when you are ready."
      );
    });
  }, [attemptNumber, isHydrated, phase, recorder.state.recordingStatus, token]);

  useEffect(() => {
    // Gates the welcome stage: a participant must not be asked to consent to
    // screen and microphone recording on a device that can never do it.
    setDeviceSnapshot(collectDeviceSnapshot());
  }, []);

  const activeSectionIndex =
    phase === "declined" ? 1 : phaseStepIndex[phase];

  useEffect(() => {
    if (!isHydrated) {
      return;
    }

    // One continuous page: advancing a section must bring the newly current
    // one into view rather than resetting to the page top, or the
    // participant is left scrolled past everything they already did.
    const target = sectionRefs.current[activeSectionIndex];

    if (!target) {
      return;
    }

    target.scrollIntoView({
      behavior: hasScrolledOnMountRef.current ? "smooth" : "auto",
      block: "start"
    });
    hasScrolledOnMountRef.current = true;
  }, [activeSectionIndex, isHydrated]);

  const runSetupChecks = useCallback(async () => {
    setSetupRunState("running");
    setCheckError(null);

    try {
      await sendRuntimeEvent(token, {
        attemptNumber,
        eventType: "setup_started"
      });

      const snapshot = await collectSetupSnapshot();
      const nextAssessment = assessSetupReadiness(snapshot);

      setAssessment(nextAssessment);
      setSetupRunState("complete");

      if (nextAssessment.canProceed) {
        await sendRuntimeEvent(token, {
          attemptNumber,
          eventType: "setup_completed"
        });
      }
    } catch {
      setAssessment(null);
      setSetupRunState("complete");
      setCheckError(
        "We could not check your browser. Refresh the page and try again."
      );
    }
  }, [attemptNumber, token]);

  useEffect(() => {
    if (phase !== "setup") {
      setupAutoRunRef.current = false;
      return;
    }

    if (!isHydrated || setupAutoRunRef.current) {
      return;
    }

    // Checks auto-run the moment the setup section becomes current - there is
    // no manual first trigger. "Check again" re-runs them on demand.
    setupAutoRunRef.current = true;
    void runSetupChecks();
  }, [isHydrated, phase, runSetupChecks]);

  useEffect(() => {
    // The only route into Done: the upload section renders purely from
    // recorder state, and the phase advances the moment the upload is
    // durably stored - including when an externally-stopped share finished
    // the upload before the participant completed the tasks.
    if (phase === "uploading" && recorder.state.uploadStatus === "complete") {
      setPhase("completed");
    }
  }, [phase, recorder.state.uploadStatus]);

  const isNavigationGuarded = shouldGuardNavigation(recorder.state);

  useEffect(() => {
    if (!isNavigationGuarded) {
      return;
    }

    // The recording exists only as in-memory chunks until its upload lands, so
    // a refresh, tab close or external navigation destroys a session the
    // participant has already sat through. Browsers show their own generic
    // wording; returnValue is required by the API but never displayed.
    // NOTE: this does not cover in-app navigation - the client-side router
    // never unloads the document. The nav's Study hub link is locked below
    // instead.
    function handleBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }

    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [isNavigationGuarded]);

  const returnUrl = payload.session.return_url;

  function captureUploadedAsset(asset: UploadedAsset | null) {
    if (asset) {
      setCompletionSummary((current) =>
        current ? { ...current, uploadedAsset: asset } : current
      );
    }
  }

  const taskSteps = useMemo(
    () => payload.steps.filter((step) => step.type !== "end"),
    [payload.steps]
  );

  // The page the participant opens and shares before recording starts. Null
  // for survey-style studies with no external product, which keep the single
  // start action rather than the open-then-share sequence.
  const primaryTargetUrl = useMemo(
    () => getPrimaryTargetUrl(payload.steps),
    [payload.steps]
  );
  const targetDescription = useMemo(
    () => (primaryTargetUrl ? describeTarget(primaryTargetUrl) : null),
    [primaryTargetUrl]
  );

  const participantLabel =
    payload.participant.display_name ?? payload.participant.participant_id;
  const duration = payload.study.estimated_duration_minutes;
  const sessionMeta = `${
    duration != null ? `~${duration} min · ` : ""
  }${taskSteps.length} task${taskSteps.length === 1 ? "" : "s"}`;

  // Shared by the page's launch step AND the floating pane's standby card, so
  // the participant can start from whichever window is in front of them.
  const startRecording = async () => {
    setRecoveryMessage(null);
    // If the participant closed the task window after opening it, reopen it
    // before the picker appears - otherwise the window they are told to share
    // is not in the list. A pane click's activation DOES cover the opener's
    // window.open - verified live in Chrome 2026-08-16 (the pane's own "Open
    // the task page" button opens the popup unblocked). If a browser ever
    // refuses it, the whole-screen share option still works and the page's
    // own button covers it.
    if (primaryTargetUrl && !taskWindow.isOpen()) {
      taskWindow.openTaskWindow(primaryTargetUrl);
    }
    const started = await recorder.startCapture();

    if (started) {
      // No window is opened here. The panel is the participant's to ask for
      // (the setup step's own control), and re-springing one they chose to
      // close would be exactly the unbidden behaviour that control exists to
      // remove. Nothing is awaited between capture going live and the phase
      // flip either: suspending here paints an ENABLED "Start recording"
      // button over a running recording, and startCapture has no re-entrancy
      // guard, so a second press orphans the first recording's chunks.
      setPhase("running");
    }
  };

  // A panel the browser refused must not leave the participant pressing a
  // dead button, so the page takes the whole launch sequence back.
  const [paneRefused, setPaneRefused] = useState(false);

  const openTaskPane = async () => {
    const opened = await taskPip.openTaskPip();

    if (!opened) {
      setPaneRefused(true);
    }
  };

  // ONE computation, passed to both the page's launch step and the pane's
  // standby card, so the pane can never start what the page's own button
  // could not - the invariant holds by construction, not by two expressions
  // happening to agree.
  const canStart =
    setupRunState === "complete" &&
    !checkError &&
    Boolean(assessment?.canProceed);

  return (
    <div className="journey-frame">
      <div className="journey-app">
        <nav aria-label="Session" className="journey-nav">
          <div className="journey-brand">
            <span aria-hidden="true" className="journey-brand-logo" />
            <span className="journey-brand-name">
              <b>Recorded study</b>
              <small>participant view</small>
            </span>
          </div>

          <p className="journey-nav-group">Session</p>
          <span aria-current="page" className="journey-nav-link journey-nav-link--active">
            {payload.study.title}
          </span>
          {isNavigationGuarded ? (
            // An in-app link would route client-side, which never fires
            // beforeunload, so the guard above cannot catch it. While the only
            // copy of the recording is in memory there must be no one-click
            // way out of the page at all.
            <span className="journey-nav-link journey-nav-link--locked">
              <span aria-hidden="true" className="journey-nav-lock-dot" />
              Recording in progress - stay on this page
            </span>
          ) : (
            <Link className="journey-nav-link" to="/">
              Study hub
            </Link>
          )}
        </nav>

        <div className="journey-work">
          <div className="journey-main">
            {!isHydrated ? (
              <p className="journey-hydrating">Restoring your session state…</p>
            ) : (
              <>
                <JourneyBlock
                  index={0}
                  sectionRef={(el) => {
                    sectionRefs.current[0] = el;
                  }}
                  status={getSectionStatus(0, phase)}
                >
                  <WelcomeStage
                    deviceSupport={assessDeviceSupport(deviceSnapshot)}
                    duration={duration}
                    isActive={getSectionStatus(0, phase) === "current"}
                    onContinue={() => setPhase("consent")}
                    payload={payload}
                  />
                </JourneyBlock>

                <JourneyBlock
                  index={1}
                  sectionRef={(el) => {
                    sectionRefs.current[1] = el;
                  }}
                  status={getSectionStatus(1, phase)}
                >
                  {phase === "declined" ? (
                    <DeclinedStage
                      onReviewConsent={() => setPhase("consent")}
                      returnHref={
                        returnUrl
                          ? buildParticipantReturnUrl(returnUrl, "declined")
                          : null
                      }
                    />
                  ) : (
                    <ConsentStage
                      consentText={payload.study.consent_text}
                      isActive={getSectionStatus(1, phase) === "current"}
                      onAccept={() => {
                        // The event is audit telemetry; a failed POST must
                        // never strand the participant on the consent section
                        // with a dead button.
                        void sendRuntimeEvent(token, {
                          attemptNumber,
                          eventType: "consent_accepted"
                        }).catch(() => null);
                        // Deliberately opens NO window. The floating panel is
                        // asked for on its own control in the setup step - an
                        // always-on-top, chrome-less window appearing over
                        // every application unbidden is not something to do to
                        // someone who has just pressed "I agree".
                        setPhase("setup");
                      }}
                      onDecline={() => {
                        void sendRuntimeEvent(token, {
                          attemptNumber,
                          eventType: "consent_declined"
                        }).catch(() => null);
                        setPhase("declined");
                      }}
                    />
                  )}
                </JourneyBlock>

                <JourneyBlock
                  index={2}
                  sectionRef={(el) => {
                    sectionRefs.current[2] = el;
                  }}
                  status={getSectionStatus(2, phase)}
                >
                  <SetupAndStartStage
                    assessment={assessment}
                    canStart={canStart}
                    paneIsPrimary={Boolean(taskPip.pipWindow)}
                    canOfferPane={
                      taskPip.isSupported && !paneRefused && !taskPip.pipWindow
                    }
                    onOpenPane={() => {
                      void openTaskPane();
                    }}
                    checkError={checkError}
                    hasTarget={Boolean(primaryTargetUrl)}
                    isActive={getSectionStatus(2, phase) === "current"}
                    recorderState={recorder.state}
                    recoveryMessage={recoveryMessage}
                    runState={setupRunState}
                    targetLabel={targetDescription?.label ?? null}
                    taskWindowStatus={taskWindow.state.status}
                    onCheckAgain={runSetupChecks}
                    onOpenTaskPage={() => {
                      // ONLY the popup here: this click's activation must be
                      // spent on window.open. The pane opened at consent (see
                      // onAccept) - opening both from one click is impossible.
                      if (primaryTargetUrl) {
                        taskWindow.openTaskWindow(primaryTargetUrl);
                      }
                    }}
                    onStart={startRecording}
                  />
                </JourneyBlock>

                <JourneyBlock
                  index={3}
                  sectionRef={(el) => {
                    sectionRefs.current[3] = el;
                  }}
                  status={getSectionStatus(3, phase)}
                >
                  {getSectionStatus(3, phase) === "current" ? (
                    <StudyRunner
                      attemptNumber={attemptNumber}
                      onComplete={async (summary) => {
                        // A fatally failed recorder has nothing to upload:
                        // entering the upload section would hang at 0% forever.
                        // Route back to the commit point instead, exactly like
                        // an interrupted run.
                        if (recorder.state.recordingStatus === "failed") {
                          clearParticipantSessionStorage(
                            window.localStorage,
                            token,
                            "runner",
                            attemptNumber
                          );
                          setRecoveryMessage(
                            recorder.state.errorMessage ??
                              "Your last attempt was interrupted, so nothing was saved. Start again when you are ready."
                          );
                          setPhase("setup");
                          void sendRuntimeEvent(token, {
                            attemptNumber,
                            eventType: "session_abandoned",
                            metadata: { source: "recorder_failure_on_completion" }
                          }).catch(() => null);

                          return;
                        }

                        // Flip to the upload section immediately; the upload
                        // runs in the background and the section renders its
                        // progress from recorder state. Resolving fast lets
                        // the runner unmount cleanly.
                        setCompletionSummary({ ...summary, uploadedAsset: null });
                        setPhase("uploading");
                        void recorder
                          .stopCaptureAndUpload()
                          .then((asset) => {
                            captureUploadedAsset(asset);
                          })
                          .catch(() => null);
                        // stopCaptureAndUpload sets its stop-in-flight guard
                        // and calls recorder.stop() synchronously before its
                        // first await, so by the time control reaches here the
                        // task window is safe to close even if the
                        // participant shared it: the recorder's own "ended"
                        // handler will see the guard already set and skip
                        // re-triggering a stop. Only on THIS branch - the
                        // recorder-failure branch above never reaches this
                        // line, so closing an abandoned attempt's task window
                        // can never resurrect it as a fresh capture-stopped
                        // upload.
                        taskWindow.closeTaskWindow();
                      }}
                      payload={payload}
                      captureStoppedExternally={recorder.state.captureStoppedExternally}
                      microphonePermission={recorder.state.microphonePermission}
                      onCloseTaskPip={taskPip.closeTaskPip}
                      onOpenTaskPip={taskPip.openTaskPip}
                      onOpenTaskWindow={(url) => taskWindow.openTaskWindow(url)}
                      pipSupported={taskPip.isSupported}
                      pipWindow={taskPip.pipWindow}
                      recordingStartedAt={recorder.state.recordingStartedAt}
                      recordingStatus={recorder.state.recordingStatus}
                      screenPermission={recorder.state.screenPermission}
                    />
                  ) : getSectionStatus(3, phase) === "done" ? (
                    <TaskSummary />
                  ) : null}
                </JourneyBlock>

                <JourneyBlock
                  index={4}
                  sectionRef={(el) => {
                    sectionRefs.current[4] = el;
                  }}
                  status={getSectionStatus(4, phase)}
                >
                  <UploadStage
                    recorderState={recorder.state}
                    onRetryUpload={async () => {
                      const asset = await recorder.retryUpload();

                      captureUploadedAsset(asset);
                    }}
                  />
                </JourneyBlock>

                <JourneyBlock
                  index={5}
                  sectionRef={(el) => {
                    sectionRefs.current[5] = el;
                  }}
                  status={getSectionStatus(5, phase)}
                >
                  {getSectionStatus(5, phase) === "current" ? (
                    <CompletedStage
                      completedAt={completionSummary?.completedAt ?? null}
                      returnHref={
                        returnUrl
                          ? buildParticipantReturnUrl(returnUrl, "completed")
                          : null
                      }
                      uploadedAsset={
                        completionSummary?.uploadedAsset ?? recorder.state.asset
                      }
                      onExitCompletedState={() => {
                        clearParticipantSessionStorage(window.localStorage, token, "all", attemptNumber);
                        setRecoveryMessage(null);
                      }}
                    />
                  ) : null}
                </JourneyBlock>
              </>
            )}
          </div>

          <aside aria-label="Session status" className="journey-rail">
            <div className="journey-rail-stick">
              <section className="journey-rail-sec">
                <h4>Participant</h4>
                <div className="journey-rail-row">
                  <span>Name</span>
                  <span className="journey-rail-val">{participantLabel}</span>
                </div>
                <div className="journey-rail-row">
                  <span>Session</span>
                  <span className="journey-rail-val">{sessionMeta}</span>
                </div>
              </section>

              <section className="journey-rail-sec">
                <h4>Recording</h4>
                <div className="journey-rail-row">
                  <span>State</span>
                  <RailStatusValue {...getRailRecordingStatus(recorder.state)} />
                </div>
                <div className="journey-rail-row">
                  <span>Microphone</span>
                  <RailStatusValue
                    {...getRailPermissionStatus(
                      recorder.state.microphonePermission,
                      recorder.state.recordingStatus
                    )}
                  />
                </div>
                <div className="journey-rail-row">
                  <span>Screen</span>
                  <RailStatusValue
                    {...getRailPermissionStatus(
                      recorder.state.screenPermission,
                      recorder.state.recordingStatus
                    )}
                  />
                </div>
              </section>

              <section className="journey-rail-sec">
                <h4>Journey</h4>
                {FLOW_SECTION_LABELS.map((label, index) => {
                  const isTicked =
                    getSectionStatus(index, phase) === "done" ||
                    (index === 5 && phase === "completed");

                  return (
                    <div
                      className={`journey-vitem${isTicked ? " journey-vitem--done" : ""}`}
                      key={label}
                    >
                      <span aria-hidden="true" className="journey-vtick">
                        ✓
                      </span>
                      {label}
                    </div>
                  );
                })}
              </section>
            </div>
          </aside>
        </div>
      </div>

      {/* The pane opens on the consent click (setup phase), before the
          runner exists to fill it. Until recording is live it carries the
          standby card - trust header, recording state, the start button and
          deliberately NO task. StudyRunner's own portal takes over when the
          running phase mounts it. */}
      {phase === "setup" && taskPip.pipWindow
        ? createPortal(
            <PipStandbyCard
              canStart={canStart}
              errorMessage={recorder.state.errorMessage}
              isStarting={recorder.state.recordingStatus === "starting"}
              studyTitle={payload.study.title}
              taskWindowStatus={taskWindow.state.status}
              onOpenTaskPage={() => {
                if (primaryTargetUrl) {
                  taskWindow.openTaskWindow(primaryTargetUrl);
                }
              }}
              onStart={startRecording}
            />,
            taskPip.pipWindow.document.body
          )
        : null}
    </div>
  );
}

function JourneyBlock({
  children,
  index,
  sectionRef,
  status
}: {
  children: React.ReactNode;
  index: number;
  sectionRef: (element: HTMLDivElement | null) => void;
  status: SectionStatus;
}) {
  // A step the participant has not reached renders NOTHING here. The Journey
  // rail names all six and tracks them; a second, taller, dashed restatement
  // of the same list was the page's biggest single waste of space. Nothing
  // scrolls to a locked block either - the scroll target is always current.
  if (status === "locked") {
    return null;
  }

  const badgeVariant =
    status === "done" ? "done" : status === "current" ? "key" : "idle";

  return (
    <section
      className={`journey-block journey-block--${status}${
        status === "current" ? " journey-block--hero" : ""
      }`}
      ref={sectionRef}
    >
      <div className="journey-block-head">
        <span
          aria-hidden="true"
          className={`journey-step journey-step--${badgeVariant}`}
        >
          {status === "done" ? "✓" : status === "ended" ? "–" : index + 1}
        </span>
        <h2 className="journey-block-title">{FLOW_SECTION_LABELS[index]}</h2>
      </div>

      {/*
        A status board, not a workspace. Once control moves to the floating
        pane the participant reads this page at a glance, so only the live
        step carries its body:

        - locked: nothing at all. The Journey rail already names every step,
          and a card repeating "Unlocks after upload succeeds" spent ~180px
          to say less than the rail's one line.
        - done: the head alone, which is already a tick, a number and a
          title - a completed line.
        - current: the full body.
      */}
      {status === "current" || status === "ended" ? (
        <div className="journey-block-body">{children}</div>
      ) : null}
    </section>
  );
}

// Deliberately no task list here. A participant who reads every prompt before
// consenting rehearses their route, and the recording captures a performance
// instead of a first encounter. Tasks are revealed one at a time once
// recording is live - the same order UserTesting uses.
function WelcomeStage({
  deviceSupport,
  isActive,
  payload,
  duration,
  onContinue
}: {
  deviceSupport: DeviceSupport;
  isActive: boolean;
  payload: SessionPayload;
  duration?: number;
  onContinue: () => void;
}) {
  return (
    <div className="journey-stage">
      <h3 className="journey-title">{payload.study.title}</h3>
      <p className="journey-lede">{payload.study.intro_text}</p>

      <div className="journey-tag-row">
        <span className="journey-tag">
          {duration != null ? `${duration} minute session` : "Session length TBD"}
        </span>
        <span className="journey-tag">Recorded · screen and mic</span>
        <span className="journey-tag">Laptop or desktop only</span>
      </div>

      {deviceSupport.canRun ? null : (
        <div className="journey-alert journey-alert--danger">
          <strong>You cannot take part on this device</strong>
          <p>{deviceSupport.reason}</p>
        </div>
      )}

      <div className="journey-infogrid">
        <article className="journey-infocell">
          <h4>What will happen</h4>
          <p>
            You will work through a short set of tasks, one at a time. There
            are no right answers - we are testing the product, not you.
          </p>
        </article>
        <article className="journey-infocell">
          <h4>Think out loud</h4>
          <p>
            Say what you are thinking as you go - what you expect, what
            surprises you. We record your screen and your voice, never your
            camera.
          </p>
        </article>
        <article className="journey-infocell">
          <h4>Before you begin</h4>
          <p>
            You will agree to being recorded, then a quick automatic check
            confirms your setup. It takes about a minute.
          </p>
        </article>
      </div>

      {isActive ? (
        <div className="journey-actions">
          <button
            className="button"
            disabled={!deviceSupport.canRun}
            onClick={onContinue}
            type="button"
          >
            Continue to consent
          </button>
        </div>
      ) : (
        <DoneLine />
      )}
    </div>
  );
}

// A passed block stays a visible record but stops presenting controls: one
// quiet mono line in the checkrow vocabulary replaces its spent actions.
function DoneLine() {
  return (
    <p className="journey-doneline">
      <span aria-hidden="true">✓</span> completed
    </p>
  );
}

function ConsentStage({
  consentText,
  isActive,
  onAccept,
  onDecline
}: {
  consentText: string;
  isActive: boolean;
  onAccept: () => void;
  onDecline: () => void;
}) {
  return (
    <div className="journey-stage">
      <h3 className="journey-title journey-title--sub">
        Review and confirm recording consent
      </h3>
      <p className="journey-lede">{consentText}</p>

      <div className="journey-infogrid">
        <article className="journey-infocell">
          <h4>What you are agreeing to</h4>
          <p>
            This study records your screen and microphone so the team can
            review your experience after the session ends.
          </p>
        </article>
        <article className="journey-infocell">
          <h4>If you decline</h4>
          <p>The study will end cleanly and no recording will begin.</p>
        </article>
      </div>

      {isActive ? (
        <div className="journey-actions">
          <button className="button" onClick={onAccept} type="button">
            I agree and want to continue
          </button>
          <button
            className="button secondary"
            onClick={onDecline}
            type="button"
          >
            I do not agree
          </button>
        </div>
      ) : (
        <DoneLine />
      )}
    </div>
  );
}

// Row copy per spec, keyed by assessor check id: the pending label names the
// capability being checked; the pass label is the spec's four pass strings.
const setupCheckRowCopy: Record<
  SetupCheckId,
  { pending: string; pass: string }
> = {
  browser: {
    pending: "Your browser can run the session",
    pass: "Chrome works for this session"
  },
  viewport: {
    pending: "Your window is big enough",
    pass: "Your window is big enough"
  },
  microphone: {
    pending: "A microphone is connected",
    pass: "A microphone is ready"
  },
  screen_share: {
    pending: "Screen sharing is available",
    pass: "Screen sharing is ready"
  }
};

const setupCheckOrder: SetupCheckId[] = [
  "browser",
  "viewport",
  "microphone",
  "screen_share"
];

function SetupAndStartStage({
  assessment,
  canOfferPane,
  canStart,
  onOpenPane,
  paneIsPrimary,
  checkError,
  hasTarget,
  isActive,
  recorderState,
  recoveryMessage,
  runState,
  targetLabel,
  taskWindowStatus,
  onCheckAgain,
  onOpenTaskPage,
  onStart
}: {
  assessment: SetupAssessment | null;
  checkError: string | null;
  hasTarget: boolean;
  isActive: boolean;
  recorderState: RecorderState;
  recoveryMessage: string | null;
  runState: SetupRunState;
  targetLabel: string | null;
  taskWindowStatus: TaskWindowStatus;
  onCheckAgain: () => Promise<void>;
  onOpenPane: () => void;
  onOpenTaskPage: () => void;
  onStart: () => Promise<void>;
  // The panel is available and not yet up, so the page offers to open it
  // rather than rendering the sequence it is about to hand over. False on
  // Firefox and Safari, and after a refusal, where the page keeps the lot.
  canOfferPane: boolean;
  // Computed ONCE by the parent and shared with the pane's standby card, so
  // the two start buttons can never disagree about readiness. Do not derive
  // it locally again.
  canStart: boolean;
  // True while the floating pane is up and carrying the same two actions.
  // The page then points at it instead of rendering rival buttons - but it
  // takes the sequence straight back the moment the pane goes (Firefox and
  // Safari never have one, and the participant can close it).
  paneIsPrimary: boolean;
}) {
  const isChecking = runState !== "complete";
  const isStarting = recorderState.recordingStatus === "starting";
  const failedChecks =
    assessment?.checks.filter((check) => check.status === "fail") ?? [];

  const verdict = isChecking
    ? "Checking your setup…"
    : checkError
      ? "We could not check your setup"
      : assessment?.canProceed
        ? assessment.warningChecks === 0
          ? "You are ready to go. Everything passed"
          : "You are ready to go"
        : formatFailedVerdict(failedChecks);

  const verdictDetail = isChecking
    ? null
    : checkError ??
      (assessment && (!assessment.canProceed || assessment.warningChecks > 0)
        ? assessment.summary
        : null);

  const hint = isChecking
    ? "Waiting for checks to pass"
    : isStarting
      ? getPermissionSequenceCopy(recorderState)
      : canStart
        ? "One press starts the browser prompts"
        : "Waiting for checks to pass";

  return (
    <div className="journey-stage">
      <p className="journey-verdict">
        {!isChecking && !checkError && assessment?.canProceed ? (
          <span aria-hidden="true" className="journey-verdict-tick">
            ✓{" "}
          </span>
        ) : null}
        {verdict}
      </p>
      {verdictDetail ? (
        <p className="journey-verdict-detail">{verdictDetail}</p>
      ) : null}

      {isActive && recoveryMessage ? (
        <div className="journey-alert journey-alert--danger">
          <strong>Your last attempt was interrupted</strong>
          <p>{recoveryMessage}</p>
        </div>
      ) : null}

      <div className="journey-checkrows">
        {isChecking || !assessment
          ? setupCheckOrder.map((id) => (
              <div className="journey-checkrow is-pending" key={id}>
                <span aria-hidden="true" className="journey-cbx" />
                <span className="journey-cname">
                  {setupCheckRowCopy[id].pending}
                </span>
                <span className="journey-cstate">checking…</span>
              </div>
            ))
          : assessment.checks.map((check) =>
              check.status === "pass" ? (
                <div className="journey-checkrow is-pass" key={check.id}>
                  <span aria-hidden="true" className="journey-cbx">
                    ✓
                  </span>
                  <span className="journey-cname">
                    {setupCheckRowCopy[check.id].pass}
                  </span>
                  <span className="journey-cstate">pass</span>
                </div>
              ) : (
                <div
                  className={`journey-checkrow is-${check.status}`}
                  key={check.id}
                >
                  <span aria-hidden="true" className="journey-cbx">
                    {check.status === "fail" ? "✕" : "!"}
                  </span>
                  <span className="journey-cname">
                    <strong>{check.label}</strong> · {check.detail}
                    {check.remediation ? (
                      <span className="journey-remediation">
                        {check.remediation}
                      </span>
                    ) : null}
                  </span>
                  <span className="journey-cstate">
                    {check.status === "fail" ? "fail" : "warn"}
                  </span>
                </div>
              )
            )}
      </div>

      {isActive && recorderState.errorMessage ? (
        <div className="journey-alert journey-alert--danger">
          <strong>Recording could not start</strong>
          <p>{recorderState.errorMessage}</p>
        </div>
      ) : null}

      {hasTarget ? (
        isActive ? (
          canOfferPane ? (
            <div className="journey-actions">
              <button className="button" onClick={onOpenPane} type="button">
                Open the task window
              </button>
              <span className="journey-hint">
                Your tasks open in a small window that stays on top while you
                work.
              </span>
            </div>
          ) : paneIsPrimary ? (
            <>
              <p className="journey-launch-copy">
                Your controls are in the floating panel. Open the task page and
                start recording from there - this page takes over if you close
                it.
              </p>
              {/* The checks and their re-run stay HERE even while deferring:
                  the pane reports "waiting for the setup checks in the Cortex
                  tab", so the tab must keep the button that clears them or a
                  failed check is a dead end. */}
              <div className="journey-actions journey-actions--secondary">
                <button
                  className="button secondary"
                  disabled={isChecking || isStarting}
                  onClick={() => {
                    void onCheckAgain();
                  }}
                  type="button"
                >
                  Check again
                </button>
              </div>
            </>
          ) : (
          <TaskLaunch
            canStart={canStart}
            isChecking={isChecking}
            isStarting={isStarting}
            permissionCopy={getPermissionSequenceCopy(recorderState)}
            targetLabel={targetLabel ?? "the task page"}
            taskWindowStatus={taskWindowStatus}
            onCheckAgain={onCheckAgain}
            onOpenTaskPage={onOpenTaskPage}
            onStart={onStart}
          />
          )
        ) : (
          <DoneLine />
        )
      ) : (
        <>
          {/* No external product to open: the participant records this tab or
              their whole screen, so the single start action and its generic
              explainer stand. */}
          <article className="journey-infocell journey-infocell--explainer">
            <h4>When you press start</h4>
            <p>
              The browser asks for your microphone on this tab, then which
              screen or window to share. Stay on this page - the first task
              appears once recording is live. Nothing is recorded before that.
            </p>
          </article>

          {isActive ? (
            <div className="journey-actions">
              <button
                className="button"
                disabled={!canStart || isStarting}
                onClick={() => {
                  void onStart();
                }}
                type="button"
              >
                {isStarting ? "Requesting permissions…" : "Start recorded study"}
              </button>
              <button
                className="button secondary"
                disabled={isChecking || isStarting}
                onClick={() => {
                  void onCheckAgain();
                }}
                type="button"
              >
                Check again
              </button>
              <span className="journey-hint">{hint}</span>
            </div>
          ) : (
            <DoneLine />
          )}
        </>
      )}
    </div>
  );
}

/**
 * The recorded-study launch sequence: open the task page in its own window,
 * then start recording and share that window. Two explicit, ordered actions
 * instead of one, so the window exists before the share picker asks for it -
 * the only way it can appear in the picker to be chosen.
 */
function TaskLaunch({
  canStart,
  isChecking,
  isStarting,
  permissionCopy,
  targetLabel,
  taskWindowStatus,
  onCheckAgain,
  onOpenTaskPage,
  onStart
}: {
  canStart: boolean;
  isChecking: boolean;
  isStarting: boolean;
  permissionCopy: string;
  targetLabel: string;
  taskWindowStatus: TaskWindowStatus;
  onCheckAgain: () => Promise<void>;
  onOpenTaskPage: () => void;
  onStart: () => Promise<void>;
}) {
  const taskPageOpened = taskWindowStatus === "open";

  return (
    <div className="journey-launch">
      <ol className="journey-launch-steps">
        <li
          className={`journey-launch-step${
            taskPageOpened ? " is-done" : canStart ? " is-active" : ""
          }`}
        >
          <span aria-hidden="true" className="journey-launch-num">
            {taskPageOpened ? "✓" : "1"}
          </span>
          <div className="journey-launch-body">
            <h4 className="journey-launch-title">Open the task page</h4>
            {taskPageOpened ? (
              <p className="journey-launch-copy">
                Task page open in a new window.{" "}
                <button
                  className="journey-inline-link"
                  onClick={onOpenTaskPage}
                  type="button"
                >
                  Open it again
                </button>{" "}
                if you closed it.
              </p>
            ) : (
              <>
                <p className="journey-launch-copy">
                  Opens {targetLabel} in its own window. You will share that
                  window in the next step.
                </p>
                {taskWindowStatus === "blocked" ? (
                  <div className="journey-alert journey-alert--danger">
                    <strong>Your browser blocked the pop-up</strong>
                    <p>
                      Allow pop-ups for this site, then{" "}
                      <button
                        className="journey-inline-link"
                        onClick={onOpenTaskPage}
                        type="button"
                      >
                        open the task page
                      </button>{" "}
                      again.
                    </p>
                  </div>
                ) : null}
                <div className="journey-actions">
                  <button
                    className="button"
                    disabled={!canStart}
                    onClick={onOpenTaskPage}
                    type="button"
                  >
                    Open the task page
                  </button>
                </div>
              </>
            )}
          </div>
        </li>

        <li
          className={`journey-launch-step${
            taskPageOpened ? " is-active" : " is-locked"
          }`}
        >
          <span aria-hidden="true" className="journey-launch-num">
            2
          </span>
          <div className="journey-launch-body">
            <h4 className="journey-launch-title">
              Start recording and share the task page
            </h4>
            <p className="journey-launch-copy">
              Allow your microphone, then in the chooser open the{" "}
              <b>Window</b> tab and pick {targetLabel}. Can’t find it? Sharing
              your whole screen also works. This page keeps your task list - the
              work happens in the task window.
            </p>
            {taskPageOpened ? (
              <div className="journey-actions">
                <button
                  className="button"
                  disabled={isStarting || !canStart}
                  onClick={() => {
                    void onStart();
                  }}
                  type="button"
                >
                  {isStarting ? "Requesting permissions…" : "Start recording"}
                </button>
                <span className="journey-hint">
                  {isStarting
                    ? permissionCopy
                    : "One press starts the browser prompts"}
                </span>
              </div>
            ) : (
              <p className="journey-hint">Open the task page first</p>
            )}
          </div>
        </li>
      </ol>

      <div className="journey-actions journey-actions--secondary">
        <button
          className="button secondary"
          disabled={isChecking || isStarting}
          onClick={() => {
            void onCheckAgain();
          }}
          type="button"
        >
          Check again
        </button>
      </div>
    </div>
  );
}

function formatFailedVerdict(failedChecks: SetupCheck[]) {
  if (failedChecks.length === 0) {
    return "Something needs fixing before you can start";
  }

  const labels = failedChecks.map((check) => check.label);
  const joined =
    labels.length === 1
      ? labels[0]
      : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;

  return `${joined} need${labels.length === 1 ? "s" : ""} attention before you can start`;
}

function TaskSummary() {
  return (
    <div className="journey-checkrows journey-checkrows--single">
      <div className="journey-checkrow is-pass">
        <span aria-hidden="true" className="journey-cbx">
          ✓
        </span>
        <span className="journey-cname">All tasks completed</span>
        <span className="journey-cstate">done</span>
      </div>
    </div>
  );
}

function UploadStage({
  recorderState,
  onRetryUpload
}: {
  recorderState: RecorderState;
  onRetryUpload: () => Promise<void>;
}) {
  const hasFailed = recorderState.uploadStatus === "failed";
  const isComplete = recorderState.uploadStatus === "complete";
  const percentage = isComplete
    ? 100
    : recorderState.uploadProgress?.percentage ?? 0;

  return (
    <div className="journey-stage">
      <h3 className="journey-title journey-title--sub">
        {hasFailed
          ? "Upload interrupted"
          : isComplete
            ? "Upload complete"
            : "Uploading your recording"}
      </h3>
      <p className="journey-lede">
        {isComplete
          ? "Your recording was saved successfully."
          : "Stay on this page until it completes. Recording has stopped."}
      </p>

      <div
        aria-label="Upload progress"
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={percentage}
        className="journey-progresswrap"
        role="progressbar"
      >
        <div
          className="journey-progressbar"
          style={{ width: `${percentage}%` }}
        />
      </div>
      <p className="journey-progress-pct">{percentage}%</p>

      {hasFailed ? (
        <div className="journey-uperr">
          <p>
            Your recording is safe on this device. Check your connection and
            retry - nothing is lost.
          </p>
          <div className="journey-actions">
            <button
              className="button"
              onClick={() => {
                void onRetryUpload();
              }}
              type="button"
            >
              Retry upload
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CompletedStage({
  completedAt,
  returnHref,
  uploadedAsset,
  onExitCompletedState
}: {
  completedAt: string | null;
  returnHref: string | null;
  uploadedAsset: UploadedAsset | null;
  onExitCompletedState: () => void;
}) {
  const [showDetails, setShowDetails] = useState(false);

  return (
    <div className="journey-stage">
      <h3 className="journey-title">Recording captured</h3>
      <p className="journey-lede">
        All done - thanks for taking part. Your screen recording and responses
        are saved.
      </p>

      <article className="journey-infocell journey-infocell--explainer">
        <h4>What happens next</h4>
        <p>
          Nothing else is needed from you. The research team can now review
          your session.
        </p>
      </article>

      <div className="journey-actions">
        {returnHref ? (
          // Replaces a 3-second auto-redirect that fired regardless of what
          // the participant was doing - including mid-read of the session
          // details they had just opened. Returning is their decision, not a
          // timer's.
          <a className="button" href={returnHref} onClick={onExitCompletedState}>
            Return to the study hub
          </a>
        ) : null}
        <button
          className="button secondary"
          onClick={() => {
            setShowDetails((current) => !current);
          }}
          type="button"
        >
          {showDetails ? "Hide session details" : "Show session details"}
        </button>
      </div>

      {showDetails ? (
        <div className="journey-infogrid">
          <article className="journey-infocell">
            <h4>Completion time</h4>
            <p>
              {completedAt
                ? new Intl.DateTimeFormat("en-GB", {
                    dateStyle: "medium",
                    timeStyle: "short"
                  }).format(new Date(completedAt))
                : "Just now"}
            </p>
          </article>
          <article className="journey-infocell">
            <h4>Recording upload</h4>
            <p>
              {uploadedAsset
                ? `Uploaded ${formatFileSize(uploadedAsset.fileSizeBytes)} of video.`
                : "Your recording was uploaded."}
            </p>
          </article>
        </div>
      ) : null}
    </div>
  );
}

function DeclinedStage({
  onReviewConsent,
  returnHref
}: {
  onReviewConsent: () => void;
  returnHref: string | null;
}) {
  return (
    <div className="journey-stage">
      <div className="journey-gate journey-gate--ended">
        Study ended cleanly. No recording began.
      </div>

      {returnHref ? (
        <div className="journey-actions">
          <a className="button" href={returnHref}>
            Return to the study hub
          </a>
        </div>
      ) : null}

      <p className="journey-declined-note">
        Declined by mistake?{" "}
        <button
          className="journey-inline-link"
          onClick={onReviewConsent}
          type="button"
        >
          Review consent again
        </button>
      </p>
    </div>
  );
}

function getPermissionSequenceCopy(recorderState: RecorderState) {
  if (recorderState.microphonePermission === "requesting") {
    return "Approve microphone access on this tab first. The screen-share chooser comes next.";
  }

  if (
    recorderState.microphonePermission === "granted" &&
    recorderState.screenPermission === "requesting"
  ) {
    return "Microphone is ready. In the chooser, open the Window tab and pick the task page - or share your whole screen.";
  }

  if (
    recorderState.microphonePermission === "granted" &&
    recorderState.screenPermission === "granted"
  ) {
    return "Both permissions are approved. Recording should go live before the first task appears.";
  }

  return "Approve the browser prompts in order before moving into the task.";
}

function RailStatusValue({
  label,
  isWarning
}: {
  label: string;
  isWarning: boolean;
}) {
  return (
    <span
      className={`journey-rail-val${isWarning ? " journey-rail-val--warn" : ""}`}
    >
      {label}
    </span>
  );
}

/**
 * Recording state in participant terms. Neutral values render muted grey; only
 * a genuine failure earns the warning treatment.
 */
function getRailRecordingStatus(state: RecorderState): {
  label: string;
  isWarning: boolean;
} {
  switch (state.recordingStatus) {
    case "starting":
      return { label: "Prompting", isWarning: false };
    case "active":
      return { label: "Live", isWarning: false };
    case "stopping":
      return { label: "Stopped, uploading", isWarning: false };
    case "stopped":
      if (state.uploadStatus === "complete") {
        return { label: "Uploaded", isWarning: false };
      }

      if (state.uploadStatus === "failed") {
        return { label: "Upload interrupted", isWarning: true };
      }

      return { label: "Stopped, uploading", isWarning: false };
    case "failed":
      return { label: "Not started", isWarning: false };
    case "not_started":
    default:
      return { label: "Not started", isWarning: false };
  }
}

function getRailPermissionStatus(
  permission: RecorderState["microphonePermission"],
  recordingStatus: RecorderState["recordingStatus"]
): { label: string; isWarning: boolean } {
  switch (permission) {
    case "requesting":
      return { label: "Prompting", isWarning: false };
    case "granted":
      // Granted tracks are only live while capture runs; once recording has
      // stopped the rail must not claim otherwise.
      return recordingStatus === "starting" || recordingStatus === "active"
        ? { label: "Live", isWarning: false }
        : { label: "Stopped", isWarning: false };
    case "denied":
      return { label: "Denied", isWarning: true };
    case "cancelled":
      return { label: "Cancelled", isWarning: false };
    case "unavailable":
      return { label: "Unavailable", isWarning: true };
    case "not_requested":
    default:
      return { label: "Not requested", isWarning: false };
  }
}
