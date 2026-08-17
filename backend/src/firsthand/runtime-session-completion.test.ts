import { describe, expect, it } from "vitest";

import type { SessionPayload } from "../../../shared/firsthand/contract";
import {
  applyDerivedStatusFromEvent,
  createRuntimeSessionRecord
} from "./runtime-session-model";

/**
 * What `session_completed` means for a session that never uploads anything.
 *
 * The transition used to read `uploadStatus === "complete" ? "completed" :
 * "uploading"`, which is right for a RECORDED session - finishing the tasks is
 * not finishing the session, because the recording still has to land. A survey
 * uploads nothing, so its uploadStatus never leaves `not_started` and every
 * finished survey sat in `uploading` forever.
 *
 * That was not cosmetic. `completion-events.ts` gates the analytics write on
 * the same status, so no `opportunity_session_events` row was ever written for
 * a native survey - the researcher's own view showed answers with no starts and
 * no completions, permanently, and nothing surfaced the discrepancy.
 */

const payload = (): SessionPayload => ({
  contract_version: "1.0",
  study: {
    id: "study_survey",
    title: "Pulse",
    intro_text: "Intro",
    consent_text: "Consent"
  },
  participant: { participant_id: "user-1" },
  session: {
    session_id: "session_1",
    session_token: "fh_tok",
    study_id: "study_survey",
    participant_id: "user-1"
  },
  steps: [
    { step_id: "study_survey_step_1", order: 1, type: "nps", prompt: "Recommend?" }
  ]
});

const completedAt = "2026-08-17T12:00:00.000Z";

const complete = (record: ReturnType<typeof createRuntimeSessionRecord>) => {
  applyDerivedStatusFromEvent(record, {
    id: "e1",
    sessionId: record.sessionId,
    eventType: "session_completed",
    timestamp: completedAt
  } as never);
  return record;
};

describe("finishing a session that uploads nothing", () => {
  it("completes a survey rather than leaving it uploading forever", () => {
    const record = createRuntimeSessionRecord(payload(), {
      attemptNumber: 1,
      sessionId: "session_1"
    });

    expect(record.uploadStatus).toBe("not_started");

    expect(complete(record).sessionStatus).toBe("completed");
  });

  it("records when it finished", () => {
    const record = complete(
      createRuntimeSessionRecord(payload(), {
        attemptNumber: 1,
        sessionId: "session_1"
      })
    );

    expect(record.completedAt).toBe(completedAt);
  });

  /**
   * The recorded flow's rule is unchanged and must stay that way: finishing the
   * tasks is not finishing the session while the recording is still uploading,
   * and calling it complete would tell a researcher the artefact had arrived
   * when it had not.
   */
  it("still waits for a recording that is mid-upload", () => {
    const record = createRuntimeSessionRecord(payload(), {
      attemptNumber: 1,
      sessionId: "session_1"
    });
    record.uploadStatus = "in_progress";

    expect(complete(record).sessionStatus).toBe("uploading");
  });

  it("completes once that upload has landed", () => {
    const record = createRuntimeSessionRecord(payload(), {
      attemptNumber: 1,
      sessionId: "session_1"
    });
    record.uploadStatus = "complete";

    expect(complete(record).sessionStatus).toBe("completed");
  });
});
