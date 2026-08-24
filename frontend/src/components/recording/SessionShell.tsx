import { Link } from "react-router-dom";

import type { SessionPayload } from "@shared/firsthand/contract";
import type { DirectRecordingUploadMode } from "../../lib/recording/runtime-client";
import { ParticipantSessionFlow } from "./ParticipantSessionFlow";

export type SessionShellResult =
  | { kind: "ok"; payload: SessionPayload }
  | { kind: "error"; message: string };

type SessionShellProps = {
  attemptNumber?: number;
  directRecordingUploadMode: DirectRecordingUploadMode;
  forceReset?: boolean;
  result: SessionShellResult;
};

/**
 * The recorded-session frame. Ported from FirstHand `session-shell.tsx`: a
 * self-contained full-page surface (its own scoped styles, no Cortex chrome) so
 * the participant has no one-click way out while a recording is only held in
 * memory. On a valid session it mounts the participant journey; otherwise it
 * shows a minimal, participant-safe "link no longer active" card.
 */
export function SessionShell({
  attemptNumber,
  directRecordingUploadMode,
  forceReset = false,
  result
}: SessionShellProps) {
  return (
    <main
      className={`fh-recording fh-recording-page session-layout${
        result.kind === "ok" ? " session-layout--journey" : ""
      }`}
    >
      {result.kind === "ok" ? (
        <ParticipantSessionFlow
          attemptNumber={attemptNumber ?? 1}
          directRecordingUploadMode={directRecordingUploadMode}
          forceReset={forceReset}
          payload={result.payload}
          // The canonical session token is the one echoed inside the payload,
          // not the raw route param: every downstream key (localStorage, runtime
          // events, the recorder) must agree even if the two ever diverge.
          token={result.payload.session.session_token}
        />
      ) : (
        <>
          <Link className="back-link" to="/">
            Back to overview
          </Link>
          <InvalidSessionShell message={result.message} />
        </>
      )}
    </main>
  );
}

function InvalidSessionShell({ message }: { message: string }) {
  // Deliberately minimal. This is the first thing a real participant meets when
  // an invitation link has gone stale, so it says what happened and what to do,
  // and nothing else - never a raw token or internal id.
  return (
    <section className="session-card">
      <p className="eyebrow">Session unavailable</p>
      <h1>This link is no longer active</h1>
      <p className="lede">{message}</p>

      <div className="status-grid">
        <article className="status-card">
          <p className="meta-label">What to do next</p>
          <strong>Reply to the invitation you were sent</strong>
          <p className="status-copy">
            The research team can send you a new link. Nothing has been recorded
            and you do not need to do anything else.
          </p>
        </article>
      </div>
    </section>
  );
}
