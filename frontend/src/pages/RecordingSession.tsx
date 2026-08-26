import { useEffect, useState } from "react";
import { Navigate, useParams, useSearchParams } from "react-router-dom";

import { useAuth } from "../contexts/AuthContext";
import useDocumentTitle from "../hooks/useDocumentTitle";
import { getApiBaseUrl } from "../config/api";
import type { SessionPayload } from "@shared/firsthand/contract";
import {
  SessionShell,
  type SessionShellResult
} from "../components/recording/SessionShell";
import "../components/recording/recording-session.css";

// Participant recording surface at `/session/:token` (B6). Ported from
// FirstHand's `src/app/session/[token]/page.tsx`, but the server-side load,
// participant-OIDC email gate and attempt-seeding become a client fetch of the
// in-process runtime API (B4): GET /:token binds the token to the logged-in
// Cortex user (403 on mismatch) and returns the payload, GET /:token/runtime
// seeds the runtime and resolves the attempt number. The screen is a full-page
// takeover outside the Cortex chrome so there is no one-click exit while a
// recording is only held in memory.
//
// Storage is S3-only (H9): the browser presigns a direct-to-S3 upload. The
// handoff mints an internal `/session/:token` and routes here; the standalone
// FirstHand app and its HMAC hop are gone.
const DIRECT_RECORDING_UPLOAD_MODE = "s3" as const;

function messageForStatus(status: number): string {
  switch (status) {
    case 403:
      return "This session belongs to a different participant. Sign in with the account the invitation was sent to.";
    case 410:
      return "This session link has expired. Please contact the research team for a new invitation.";
    case 422:
      return "This session could not be opened because the study payload is malformed.";
    case 401:
      return "Your sign-in has expired. Reload the page and sign in again to continue.";
    case 404:
      return "This session link is invalid or no longer available. Please contact the research team that sent it.";
    default:
      return "This session link could not be opened. Please contact the research team that sent it.";
  }
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; result: SessionShellResult; attemptNumber: number };

function FullPageLoader() {
  return (
    <div className="fh-recording fh-recording-page">
      <p className="journey-hydrating" style={{ padding: "2rem" }}>
        Opening your session…
      </p>
    </div>
  );
}

const RecordingSession = () => {
  const { user, loading, initialAuthCheck } = useAuth();
  const { token } = useParams<{ token: string }>();
  const [searchParams] = useSearchParams();
  const [state, setState] = useState<LoadState>({ status: "loading" });

  // Static title for the participant recording surface (A4 precedent wording).
  // Placed before the early returns below to keep hook order unconditional.
  useDocumentTitle("Recorded session");

  const isAuthResolved = !loading && initialAuthCheck;
  const isLoggedIn = Boolean(user);
  const attemptParam = searchParams.get("attempt");
  const forceReset =
    searchParams.get("fresh") === "1" || searchParams.get("reset") === "1";

  useEffect(() => {
    if (!isAuthResolved || !isLoggedIn || !token) {
      return;
    }

    let cancelled = false;
    setState({ status: "loading" });

    const base = getApiBaseUrl();
    const sessionUrl = `${base}/api/firsthand/session/${encodeURIComponent(token)}`;

    (async () => {
      try {
        const payloadResponse = await fetch(sessionUrl, {
          credentials: "include",
          headers: { Accept: "application/json" }
        });

        if (!payloadResponse.ok) {
          if (cancelled) return;
          setState({
            status: "ready",
            result: { kind: "error", message: messageForStatus(payloadResponse.status) },
            attemptNumber: 1
          });
          return;
        }

        const payload = (await payloadResponse.json()) as SessionPayload;

        // Seed the runtime and resolve which attempt to run, mirroring
        // FirstHand's server-side seedRuntimeSession before render. Best-effort:
        // the first runtime mutation also seeds, so a failure here just defaults
        // to attempt 1 rather than blocking the participant.
        let attemptNumber = 1;
        const attemptQuery =
          attemptParam && /^\d+$/.test(attemptParam)
            ? `?attempt=${encodeURIComponent(attemptParam)}`
            : "";

        try {
          const runtimeResponse = await fetch(`${sessionUrl}/runtime${attemptQuery}`, {
            credentials: "include",
            headers: { Accept: "application/json" }
          });

          if (runtimeResponse.ok) {
            const runtime = (await runtimeResponse.json()) as {
              attemptNumber?: number;
            };

            if (
              typeof runtime.attemptNumber === "number" &&
              runtime.attemptNumber > 0
            ) {
              attemptNumber = runtime.attemptNumber;
            }
          }
        } catch {
          // Seeding is best-effort; leave attemptNumber at 1.
        }

        if (cancelled) return;
        setState({
          status: "ready",
          result: { kind: "ok", payload },
          attemptNumber
        });
      } catch {
        if (cancelled) return;
        setState({
          status: "ready",
          result: {
            kind: "error",
            message:
              "We could not open this session. Check your connection and reload the page."
          },
          attemptNumber: 1
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isAuthResolved, isLoggedIn, token, attemptParam]);

  // Participants are logged-in Cortex users (locked decision 3); the token is
  // additionally bound to the user server-side. Gate on auth like the other
  // token-authed surfaces before fetching.
  if (!isAuthResolved) {
    return <FullPageLoader />;
  }

  if (!isLoggedIn) {
    return <Navigate to="/auth/login" replace />;
  }

  if (state.status === "loading") {
    return <FullPageLoader />;
  }

  return (
    <SessionShell
      attemptNumber={state.attemptNumber}
      directRecordingUploadMode={DIRECT_RECORDING_UPLOAD_MODE}
      forceReset={forceReset}
      result={state.result}
    />
  );
};

export default RecordingSession;
