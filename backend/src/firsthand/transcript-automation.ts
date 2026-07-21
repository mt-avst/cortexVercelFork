import {
  processTranscriptGeneration,
  queueTranscriptGeneration
} from "./runtime-repository";

// Ported from FirstHand's src/lib/transcript-automation.ts (the `server-only`
// import is dropped per H10). Kicks the prototype transcript generator after a
// recording lands: queue the job, then process it in-process when queueing
// succeeded. Callers invoke this best-effort (`.catch(() => null)`) so a
// transcript failure never blocks the participant's upload response.
export async function autoGenerateTranscriptForSession(sessionId: string) {
  const session = await queueTranscriptGeneration(sessionId);

  if (session.transcriptStatus !== "queued") {
    return session;
  }

  return processTranscriptGeneration(sessionId);
}
