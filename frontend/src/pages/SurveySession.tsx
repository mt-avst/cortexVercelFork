import { useEffect, useState } from "react";
import { Navigate, useParams } from "react-router-dom";

import { useAuth } from "../contexts/AuthContext";
import { getApiBaseUrl } from "../config/api";
import type { SessionPayload } from "../shared/firsthand/contract";
import { SurveyRunner } from "../components/survey/SurveyRunner";
import useDocumentTitle from "../hooks/useDocumentTitle";
import { buildParticipantReturnUrl } from "../lib/recording/participant-return";

/**
 * The participant surface for a native poll or survey, at `/survey/:token`.
 *
 * Keyed on a session TOKEN, not on an opportunity id, and that is not a detail:
 * every answer is written against a runtime session, so there is nothing to
 * store answers into until one has been minted. `/poll/:id` could never have
 * been this page's home - an opportunity id alone cannot mint a session, and
 * the placeholder that lived there since v6.0.0 has been removed rather than
 * left to look like a route that works.
 *
 * Deliberately NOT chrome-less like the recording surface. That one takes the
 * screen over because a recording is running and a stray click costs the
 * session; a survey is an ordinary page and a participant who wants to leave
 * should have the normal way out.
 */
export default function SurveySession() {
  const { user, loading, initialAuthCheck } = useAuth();
  const { token } = useParams<{ token: string }>();
  const [payload, setPayload] = useState<SessionPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);

  useDocumentTitle("Survey");

  const isAuthResolved = !loading && initialAuthCheck;
  const isLoggedIn = Boolean(user);

  useEffect(() => {
    if (!isAuthResolved || !isLoggedIn) {
      return;
    }

    // Unreachable through `/survey/:token` - a bare `/survey/` hits the
    // catch-all - but returning silently left the loading state up forever,
    // which is the one outcome a participant cannot act on.
    if (!token) {
      setError("This survey link is incomplete.");
      return;
    }

    let cancelled = false;
    setError(null);

    (async () => {
      try {
        const response = await fetch(
          `${getApiBaseUrl()}/api/firsthand/session/${encodeURIComponent(token)}`,
          { credentials: "include", headers: { Accept: "application/json" } }
        );

        if (cancelled) return;

        if (!response.ok) {
          // The bind check answers 403 when the token belongs to someone else,
          // which is a different thing from a link that has expired - and a
          // participant who followed their own link twice needs to be told
          // which. Anything else is reported without echoing the status.
          setError(
            response.status === 403
              ? "This survey link belongs to someone else."
              : response.status === 410
                ? "This survey link has expired. Ask the research team for a new one."
                : response.status === 404
                  ? "This survey link does not exist."
                  : "Could not open this survey. Please try again."
          );
          return;
        }

        setPayload((await response.json()) as SessionPayload);
      } catch {
        if (!cancelled) {
          setError("Could not open this survey. Please try again.");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isAuthResolved, isLoggedIn, token]);

  if (isAuthResolved && !isLoggedIn) {
    return <Navigate replace to="/" />;
  }

  if (error) {
    return (
      <div className="container mt-4">
        <div className="alert alert-warning" role="alert">
          {error}
        </div>
      </div>
    );
  }

  if (!payload) {
    return (
      <div className="container mt-4">
        <p className="text-muted">Opening the survey...</p>
      </div>
    );
  }

  if (complete) {
    // Null when the helper refuses the URL - it is the scheme-hardened one the
    // recorded flow uses, and falling back to the raw value would throw that
    // away. No link is better than an unchecked one.
    const returnUrl = payload.session.return_url
      ? buildParticipantReturnUrl(payload.session.return_url, "completed")
      : null;

    return (
      <div className="container mt-4">
        <div className="alert alert-success" role="status">
          Thanks - your answers have been sent to the research team.
        </div>
        {/* The backend mints this and it reaches the payload; without reading
            it the participant finished on a dead end, and the study page never
            showed its completion banner. Built with the same hardened helper
            the recorded flow uses rather than assigning the value directly. */}
        {returnUrl ? (
          <a
            className="btn btn-primary"
            href={returnUrl}
          >
            Back to the study
          </a>
        ) : null}
      </div>
    );
  }

  return (
    <div className="container mt-4">
      <SurveyRunner payload={payload} onComplete={() => setComplete(true)} />
    </div>
  );
}
