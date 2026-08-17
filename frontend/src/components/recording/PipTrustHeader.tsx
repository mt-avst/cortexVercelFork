/**
 * The floating pane's NON-AUTHORABLE trust strip - a security control rather
 * than decoration. The pane has no browser chrome, no nav and no study
 * context, and the task prompt below it is researcher-authored text - so
 * without this, a one-step study is a bare window containing an attacker's
 * sentence, a text input and a button, floating above every application and
 * attributed by the OS to Cortex. That is a credible surface for "re-enter
 * your SSO password to continue", whose answer would be stored as a study
 * response and typed into the recording.
 *
 * The strip carries ONLY the two things no researcher can author: the Cortex
 * wordmark and live recorder state. The study title is deliberately NOT here -
 * it is researcher-authored (`payload.study.title`), so placing it inside the
 * trust band would launder authored text with the strip's authority. Cards
 * render it below the strip, clamped, as ordinary content. Do not remove this
 * strip and do not add any authorable value to it.
 */

// THREE states, not two. "Nothing has started yet" and "your recording has
// stopped while you carry on working" are opposite situations, and rendering
// both in the danger colour spends the alarm on the resting state - after
// minutes of red, red stops meaning anything. Idle is quiet, live carries the
// dot, and only a mid-session stop is an emergency.
export type PipRecordingState = "idle" | "live" | "stopped";

const STATE_LABELS: Record<PipRecordingState, string> = {
  idle: "Not recording",
  live: "Recording",
  stopped: "Recording stopped"
};

export function PipTrustHeader({ state }: { state: PipRecordingState }) {
  return (
    <header className="pip-trust">
      <span className="pip-trust-brand">Cortex</span>
      <span className={`pip-trust-rec is-${state}`}>
        {state === "live" ? (
          <span aria-hidden="true" className="recording-dot" />
        ) : null}
        {STATE_LABELS[state]}
      </span>
    </header>
  );
}
