import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { verifyAssetMediaSignature } from "./integration-auth";
import type { RuntimeSessionRecord } from "./runtime-records";
import {
  buildSessionOutputs,
  sessionOutputsSchema
} from "./session-outputs";

function buildSessionFixture(
  overrides: Partial<RuntimeSessionRecord> = {}
): RuntimeSessionRecord {
  return {
    sessionId: "session_abc",
    logicalSessionId: "session_abc",
    attemptNumber: 1,
    token: "fh_token",
    studyId: "study_123",
    studyTitle: "Checkout flow study",
    participantId: "user_42",
    participantDisplayName: "Jane Doe",
    sessionStatus: "completed",
    transcriptStatus: "complete",
    microphonePermission: "granted",
    screenPermission: "granted",
    recordingStatus: "stopped",
    uploadStatus: "complete",
    currentStepId: null,
    startedAt: "2026-07-15T10:00:00.000Z",
    completedAt: "2026-07-15T10:14:30.000Z",
    transcript: {
      id: "transcript_1",
      sessionId: "session_abc",
      body: "Full transcript text.",
      createdAt: "2026-07-15T10:14:35.000Z",
      source: "prototype_generated",
      segments: [
        {
          id: "seg_1",
          sessionId: "session_abc",
          stepId: "step_1",
          speaker: "system",
          speakerLabel: "Moderator",
          text: "How did you find the checkout?",
          timestamp: "2026-07-15T10:04:00.000Z"
        },
        {
          id: "seg_2",
          sessionId: "session_abc",
          stepId: "step_1",
          speaker: "participant",
          speakerLabel: "Jane Doe",
          text: "It was straightforward.",
          timestamp: "2026-07-15T10:05:00.000Z"
        }
      ]
    },
    transcriptFailureMessage: null,
    steps: [
      {
        stepId: "step_1",
        order: 1,
        type: "open_text",
        prompt: "How did you find the checkout?"
      },
      {
        stepId: "step_2",
        order: 2,
        type: "single_choice",
        prompt: "Rate the experience"
      }
    ],
    events: [],
    responses: [
      {
        id: "response_1",
        sessionId: "session_abc",
        stepId: "step_1",
        stepType: "open_text",
        responsePayload: { text: "It was straightforward." },
        savedAt: "2026-07-15T10:05:00.000Z"
      }
    ],
    assets: [
      {
        id: "asset_1",
        sessionId: "session_abc",
        fileName: "recording.webm",
        mimeType: "video/webm",
        fileSizeBytes: 10485760,
        durationSeconds: 870,
        storageProvider: "filesystem",
        relativePath: "session_abc/recording.webm",
        uploadedAt: "2026-07-15T10:14:20.000Z"
      }
    ],
    ...overrides
  };
}

describe("buildSessionOutputs", () => {
  it("maps a complete session to the snake_case outputs shape", () => {
    const session = buildSessionFixture();
    const outputs = buildSessionOutputs(session, [session]);

    expect(outputs).toEqual({
      contract_version: "1.0",
      session: {
        session_id: "session_abc",
        logical_session_id: "session_abc",
        attempt_number: 1,
        study_id: "study_123",
        study_title: "Checkout flow study",
        participant: {
          participant_id: "user_42",
          display_name: "Jane Doe"
        },
        session_status: "completed",
        started_at: "2026-07-15T10:00:00.000Z",
        completed_at: "2026-07-15T10:14:30.000Z",
        transcript_status: "complete",
        transcript_failure_message: null
      },
      attempts: [
        {
          attempt_number: 1,
          session_id: "session_abc",
          session_status: "completed",
          started_at: "2026-07-15T10:00:00.000Z",
          completed_at: "2026-07-15T10:14:30.000Z",
          transcript_status: "complete"
        }
      ],
      steps: [
        {
          step_id: "step_1",
          order: 1,
          type: "open_text",
          prompt: "How did you find the checkout?",
          response: {
            text: "It was straightforward.",
            selected_option: null,
            saved_at: "2026-07-15T10:05:00.000Z"
          }
        },
        {
          step_id: "step_2",
          order: 2,
          type: "single_choice",
          prompt: "Rate the experience",
          response: null
        }
      ],
      transcript: {
        body: "Full transcript text.",
        created_at: "2026-07-15T10:14:35.000Z",
        source: "prototype_generated",
        segments: [
          {
            id: "seg_1",
            step_id: "step_1",
            speaker: "system",
            speaker_label: "Moderator",
            text: "How did you find the checkout?",
            timestamp: "2026-07-15T10:04:00.000Z"
          },
          {
            id: "seg_2",
            step_id: "step_1",
            speaker: "participant",
            speaker_label: "Jane Doe",
            text: "It was straightforward.",
            timestamp: "2026-07-15T10:05:00.000Z"
          }
        ]
      },
      assets: [
        {
          asset_id: "asset_1",
          file_name: "recording.webm",
          mime_type: "video/webm",
          file_size_bytes: 10485760,
          duration_seconds: 870,
          uploaded_at: "2026-07-15T10:14:20.000Z",
          media_url: null
        }
      ]
    });
  });

  it("validates against the outputs schema", () => {
    const session = buildSessionFixture();
    const outputs = buildSessionOutputs(session, [session]);

    const parsed = sessionOutputsSchema.safeParse(outputs);

    expect(parsed.success).toBe(true);
  });

  it("leaves media_url null when no signing context is supplied", () => {
    const session = buildSessionFixture();
    const outputs = buildSessionOutputs(session, [session]);

    expect(outputs.assets[0].media_url).toBeNull();
  });

  it("mints a signed, verifiable media_url when a signing context is supplied", () => {
    const now = new Date(Date.UTC(2026, 6, 15, 10, 0, 0));
    const session = buildSessionFixture();
    const outputs = buildSessionOutputs(session, [session], {
      mediaUrl: { baseUrl: "https://firsthand.example.com", secret: "shared-secret", now }
    });

    const mediaUrl = outputs.assets[0].media_url;
    expect(mediaUrl).not.toBeNull();

    const url = new URL(mediaUrl as string);
    expect(url.pathname).toBe(
      "/api/sessions/session_abc/assets/asset_1/media"
    );

    const verification = verifyAssetMediaSignature({
      assetId: "asset_1",
      exp: url.searchParams.get("exp"),
      sig: url.searchParams.get("sig"),
      secret: "shared-secret",
      now
    });
    expect(verification.kind).toBe("authorized");
  });

  it("keeps media_url null for assets that are not audio/video", () => {
    const session = buildSessionFixture({
      assets: [
        {
          id: "asset_doc",
          sessionId: "session_abc",
          fileName: "notes.txt",
          mimeType: "text/plain",
          fileSizeBytes: 128,
          durationSeconds: null,
          storageProvider: "filesystem",
          relativePath: "session_abc/notes.txt",
          uploadedAt: "2026-07-15T10:14:20.000Z"
        }
      ]
    });
    const outputs = buildSessionOutputs(session, [session], {
      mediaUrl: { baseUrl: "https://firsthand.example.com", secret: "shared-secret" }
    });

    expect(outputs.assets[0].media_url).toBeNull();
  });

  it("returns response null for unanswered steps", () => {
    const session = buildSessionFixture({ responses: [] });
    const outputs = buildSessionOutputs(session, [session]);

    expect(outputs.steps.map((step) => step.response)).toEqual([null, null]);
  });

  it("orders steps by their authored order", () => {
    const session = buildSessionFixture({
      steps: [
        { stepId: "step_2", order: 2, type: "single_choice", prompt: "Second" },
        { stepId: "step_1", order: 1, type: "open_text", prompt: "First" }
      ]
    });
    const outputs = buildSessionOutputs(session, [session]);

    expect(outputs.steps.map((step) => step.step_id)).toEqual([
      "step_1",
      "step_2"
    ]);
  });

  it("picks the latest response when a step has duplicates", () => {
    const session = buildSessionFixture({
      responses: [
        {
          id: "response_old",
          sessionId: "session_abc",
          stepId: "step_1",
          stepType: "open_text",
          responsePayload: { text: "First draft" },
          savedAt: "2026-07-15T10:03:00.000Z"
        },
        {
          id: "response_new",
          sessionId: "session_abc",
          stepId: "step_1",
          stepType: "open_text",
          responsePayload: { text: "Final answer" },
          savedAt: "2026-07-15T10:06:00.000Z"
        }
      ]
    });
    const outputs = buildSessionOutputs(session, [session]);

    expect(outputs.steps[0].response?.text).toBe("Final answer");
  });

  it("maps a selected option response", () => {
    const session = buildSessionFixture({
      responses: [
        {
          id: "response_choice",
          sessionId: "session_abc",
          stepId: "step_2",
          stepType: "single_choice",
          responsePayload: { selectedOption: "Excellent" },
          savedAt: "2026-07-15T10:08:00.000Z"
        }
      ]
    });
    const outputs = buildSessionOutputs(session, [session]);

    expect(outputs.steps[1].response).toEqual({
      text: null,
      selected_option: "Excellent",
      saved_at: "2026-07-15T10:08:00.000Z"
    });
  });

  it.each(["not_requested", "queued", "processing", "failed"] as const)(
    "returns a null transcript with transcript_status %s",
    (transcriptStatus) => {
      const session = buildSessionFixture({
        transcript: null,
        transcriptStatus
      });
      const outputs = buildSessionOutputs(session, [session]);

      expect(outputs.transcript).toBeNull();
      expect(outputs.session.transcript_status).toBe(transcriptStatus);
    }
  );

  it("includes the transcript failure message when generation failed", () => {
    const session = buildSessionFixture({
      transcript: null,
      transcriptStatus: "failed",
      transcriptFailureMessage: "Transcription service unavailable"
    });
    const outputs = buildSessionOutputs(session, [session]);

    expect(outputs.session.transcript_failure_message).toBe(
      "Transcription service unavailable"
    );
  });

  it("always returns media_url null in phase 1", () => {
    const session = buildSessionFixture();
    const outputs = buildSessionOutputs(session, [session]);

    expect(outputs.assets.every((asset) => asset.media_url === null)).toBe(
      true
    );
  });

  it("sorts attempts newest first", () => {
    const attemptOne = buildSessionFixture({
      sessionId: "session_abc",
      attemptNumber: 1,
      sessionStatus: "abandoned",
      completedAt: null,
      transcript: null,
      transcriptStatus: "not_requested"
    });
    const attemptTwo = buildSessionFixture({
      sessionId: "session_abc--attempt-002",
      attemptNumber: 2
    });
    const outputs = buildSessionOutputs(attemptTwo, [attemptOne, attemptTwo]);

    expect(outputs.attempts.map((attempt) => attempt.attempt_number)).toEqual([
      2, 1
    ]);
    expect(outputs.attempts[0]).toEqual({
      attempt_number: 2,
      session_id: "session_abc--attempt-002",
      session_status: "completed",
      started_at: "2026-07-15T10:00:00.000Z",
      completed_at: "2026-07-15T10:14:30.000Z",
      transcript_status: "complete"
    });
  });

  it("does not mutate the input session or attempts", () => {
    const session = buildSessionFixture();
    const attempts = [session];
    const sessionSnapshot = structuredClone(session);

    buildSessionOutputs(session, attempts);

    expect(session).toEqual(sessionSnapshot);
    expect(attempts).toHaveLength(1);
  });
});
