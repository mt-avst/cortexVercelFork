import { useEffect, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

import { useAuth } from "../contexts/AuthContext";
import { getApiBaseUrl } from "../config/api";
import type { SessionPayload } from "@shared/firsthand/contract";
import { SurveyRunner } from "../components/survey/SurveyRunner";
import useDocumentTitle from "../hooks/useDocumentTitle";
import { buildParticipantReturnUrl } from "../lib/recording/participant-return";
import { Icon } from "../components/ui";
import { PARTICIPATE } from "@shared/pageNames";

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
 * Chrome-less like the recording surface (row 22, second-pass review): no
 * header nav, no footer feedback form stacked under an in-progress answer.
 * Unlike the recording surface, this is NOT a trap - a survey carries no
 * in-progress capture a stray click could cost, and this page supplies its
 * own explicit "Back to Participate" exit (below) rather than relying on the
 * chrome that used to sit around it. There is also no ambient `<main>`
 * landmark once the chrome is gone, so this page supplies its own.
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
      <main id="main-content" role="main" className="container mt-4">
        <div className="alert alert-warning" role="alert">
          {error}
        </div>
        <Link to="/" className="btn btn-outline-secondary mt-3">
          <Icon icon={ArrowLeft} size={16} aria-hidden="true" className="me-1" />
          Back to {PARTICIPATE}
        </Link>
      </main>
    );
  }

  if (!payload) {
    return (
      <main id="main-content" role="main" className="container mt-4">
        <p className="text-muted">Opening the survey...</p>
      </main>
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
      <main id="main-content" role="main" className="container mt-4">
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
        ) : (
          <Link to="/" className="btn btn-outline-secondary">
            <Icon icon={ArrowLeft} size={16} aria-hidden="true" className="me-1" />
          Back to {PARTICIPATE}
          </Link>
        )}
      </main>
    );
  }

  return (
    <main id="main-content" role="main" className="container mt-4">
      {/* Row 22: the only exit this page offers while the survey is still in
          progress - without the standard chrome there is no header nav to
          fall back on, and unlike the recording surface this page is not
          meant to trap anyone. */}
      <Link to="/" className="btn btn-outline-secondary mb-3">
        <Icon icon={ArrowLeft} size={16} aria-hidden="true" className="me-1" />
          Back to {PARTICIPATE}
      </Link>
      <SurveyRunner payload={payload} onComplete={() => setComplete(true)} />
    </main>
  );
}
