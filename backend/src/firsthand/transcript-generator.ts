import type {
  RuntimeSessionRecord,
  TranscriptRecord,
  TranscriptSegmentRecord
} from "./runtime-records";

export function buildPrototypeTranscript(
  session: RuntimeSessionRecord
): TranscriptRecord {
  if (session.assets.length === 0) {
    throw new Error("Transcript generation requires an uploaded recording asset.");
  }

  const transcriptCreatedAt = new Date().toISOString();
  const segments: TranscriptSegmentRecord[] = [];

  for (const step of [...session.steps].sort((left, right) => left.order - right.order)) {
    const enteredAt =
      session.events.find(
        (event) =>
          event.eventType === "step_entered" && event.stepId === step.stepId
      )?.timestamp ?? session.startedAt ?? transcriptCreatedAt;

    segments.push({
      id: crypto.randomUUID(),
      sessionId: session.sessionId,
      speaker: "system",
      speakerLabel: "Study prompt",
      stepId: step.stepId,
      text: step.prompt,
      timestamp: enteredAt
    });

    const response = session.responses.find(
      (candidate) => candidate.stepId === step.stepId
    );

    if (!response) {
      segments.push({
        id: crypto.randomUUID(),
        sessionId: session.sessionId,
        speaker: "participant",
        speakerLabel: session.participantDisplayName,
        stepId: step.stepId,
        text:
          "No typed response was captured for this step. Refer to the recording for spoken narration.",
        timestamp: enteredAt
      });
      continue;
    }

    segments.push({
      id: crypto.randomUUID(),
      sessionId: session.sessionId,
      speaker: "participant",
      speakerLabel: session.participantDisplayName,
      stepId: step.stepId,
      text:
        response.responsePayload.text?.trim() ||
        response.responsePayload.selectedOption ||
        "A response was saved for this step, but it did not include transcriptable text.",
      timestamp: response.savedAt
    });
  }

  const body = [
    "Prototype transcript",
    "This local MVP transcript is generated from saved step prompts, participant responses, and session timing metadata.",
    "",
    ...segments.map(
      (segment) =>
        `[${formatRelativeTimestamp(
          session.startedAt ?? segment.timestamp,
          segment.timestamp
        )}] ${segment.speakerLabel}: ${segment.text}`
    )
  ].join("\n");

  return {
    id: crypto.randomUUID(),
    sessionId: session.sessionId,
    body,
    createdAt: transcriptCreatedAt,
    source: "prototype_generated",
    segments
  };
}

function formatRelativeTimestamp(referenceTimestamp: string, currentTimestamp: string) {
  const deltaMs =
    new Date(currentTimestamp).getTime() - new Date(referenceTimestamp).getTime();
  const safeDelta = Number.isFinite(deltaMs) && deltaMs > 0 ? deltaMs : 0;
  const totalSeconds = Math.floor(safeDelta / 1000);
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");

  return `${minutes}:${seconds}`;
}
