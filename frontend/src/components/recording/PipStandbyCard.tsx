import type { TaskWindowStatus } from "../../lib/recording/task-window";
import { PipTrustHeader } from "./PipTrustHeader";

/**
 * What the floating pane shows between opening (the consent click) and
 * recording going live. Tasks are revealed only once recording starts, so
 * until then the pane is the participant's control strip: trust header,
 * recording state and ONE primary action that walks the launch sequence -
 * open the task page, then start recording - so they never have to dig the
 * Cortex page out from behind the task window. Never render a task prompt
 * here.
 *
 * Failures must surface HERE, not only in the Cortex tab: this pane exists
 * precisely because the participant has stopped looking at that tab, so an
 * error rendered only there is an error they never see.
 */
export function PipStandbyCard({
  canStart,
  errorMessage,
  isStarting,
  studyTitle,
  taskWindowStatus,
  onOpenTaskPage,
  onStart
}: {
  canStart: boolean;
  errorMessage: string | null;
  isStarting: boolean;
  studyTitle: string;
  taskWindowStatus: TaskWindowStatus;
  onOpenTaskPage: () => void;
  onStart: () => Promise<void>;
}) {
  const taskPageOpen = taskWindowStatus === "open";

  return (
    <section aria-label="Floating task panel" className="pip-card">
      {/* idle, never "stopped": nothing has started yet, so the danger
          colour would be crying wolf before anything can go wrong. */}
      <PipTrustHeader state="idle" />

      {errorMessage ? (
        <div className="alert-banner alert-danger" role="alert">
          <strong>Recording could not start</strong>
          <p className="status-copy">{errorMessage}</p>
        </div>
      ) : null}

      {/* Researcher-authored, so below the trust strip and any recorder
          alert, clamped by CSS - never inside the trust band. */}
      <p className="pip-trust-study">{studyTitle}</p>

      <p className="status-copy">
        Your tasks will appear here once recording starts.
      </p>
      <div className="pip-actions">
        {taskPageOpen ? (
          <>
            <button
              className="button"
              disabled={!canStart || isStarting}
              onClick={() => {
                void onStart();
              }}
              type="button"
            >
              {isStarting ? "Requesting permissions…" : "Start recording"}
            </button>
            <p className="status-copy">
              {canStart
                ? "One press starts the browser prompts."
                : "Waiting for the setup checks in the Cortex tab."}
            </p>
          </>
        ) : (
          <>
            <button
              className="button"
              disabled={!canStart}
              onClick={onOpenTaskPage}
              type="button"
            >
              Open the task page
            </button>
            <p className="status-copy">
              {!canStart
                ? "Waiting for the setup checks in the Cortex tab."
                : taskWindowStatus === "blocked"
                  ? "Your browser blocked the pop-up. Allow pop-ups for Cortex, then try again."
                  : "It opens in its own window - you will share that window next."}
            </p>
          </>
        )}
      </div>
    </section>
  );
}
