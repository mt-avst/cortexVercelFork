import { getApiBaseUrl } from "../../config/api";
import { CSRF_HEADER, CSRF_ERROR_CODE, ensureCsrfToken } from "../../api/csrf";
import { normalizeRecordingMimeType } from "./recording-mime";
import type { RuntimeEventType } from "./runtime-events";
import type { StudyStep } from "@shared/firsthand/contract";
import type { SurveyAnswer } from "@shared/firsthand/survey-answers";

// Ported from FirstHand `src/lib/runtime-client.ts` (B6). Two deliberate
// changes from the original:
//
// H9 (S3-only): the `@vercel/blob` client-upload branch is excised. Production
// uploads presign a direct-to-S3 PUT (client-upload -> finalize); the
// server-proxied POST /recording remains as the null-mode fallback for local
// dev where a direct PUT is unavailable.
//
// H2 (CSRF + no 401 redirect on the capture path): these calls use raw
// fetch / XMLHttpRequest, NOT the shared axios `api` instance, so a transient
// 401 mid-recording can never trigger the axios full-page login redirect that
// would discard the only in-memory copy of the recording. Mutating requests
// carry the double-submit `X-CSRF-Token` header and refresh it once on a CSRF
// 403, matching the axios interceptor's contract. The S3 PUT is cross-origin
// to S3 and correctly carries neither cookies nor CSRF.

// The shared schema is the single description of an answer's shape - the
// backend parses submissions against it strictly, so a field this client
// sends that the schema does not carry is a 422, not a key zod silently
// strips. Aliased rather than redeclared so this file can never hold a
// drifted hand-kept copy again.
type ResponsePayload = SurveyAnswer;

// Which direct-to-store upload protocol the participant browser should use;
// null routes uploads through the app server.
export type DirectRecordingUploadMode = "s3" | null;

/**
 * Whether a 403 response is a CSRF-token rejection (as opposed to an
 * authorization failure). Clones the response so the body stays readable for
 * the caller. Only inspected on a 403, so the success path never reads a body.
 */
async function isCsrfRejection(response: Response): Promise<boolean> {
  if (response.status !== 403) {
    return false;
  }

  try {
    const data = (await response.clone().json()) as { code?: string };
    return data?.code === CSRF_ERROR_CODE;
  } catch {
    return false;
  }
}

/**
 * POST JSON to a runtime route with the CSRF header attached and a single
 * refresh-and-retry on a CSRF 403. Same-origin credentials are included so the
 * participant's Cortex session cookie authenticates the request.
 */
async function postRuntimeJson(
  url: string,
  body: unknown
): Promise<Response> {
  const send = async () => {
    const token = await ensureCsrfToken();

    return fetch(url, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { [CSRF_HEADER]: token } : {})
      },
      body: JSON.stringify(body)
    });
  };

  const response = await send();

  if (await isCsrfRejection(response)) {
    await ensureCsrfToken(true);
    return send();
  }

  return response;
}

export async function sendRuntimeEvent(
  token: string,
  input: {
    attemptNumber?: number;
    eventType: RuntimeEventType;
    stepId?: string;
    metadata?: Record<string, unknown>;
  }
) {
  const response = await postRuntimeJson(
    buildAttemptScopedUrl(token, "runtime", input.attemptNumber),
    {
      type: "event",
      ...input
    }
  );

  if (!response.ok) {
    throw new Error("Failed to persist runtime event.");
  }
}

export async function saveParticipantResponse(
  token: string,
  input: {
    attemptNumber?: number;
    stepId: string;
    // Derived from the contract rather than spelled out again: this was a
    // hand-kept copy of stepSchema's union and had already drifted behind it.
    // The endpoint writes straight into participant_responses.step_type, so the
    // set it accepts is the contract's set by definition.
    stepType: StudyStep["type"];
    responsePayload: ResponsePayload;
  }
) {
  const response = await postRuntimeJson(
    buildAttemptScopedUrl(token, "runtime", input.attemptNumber),
    {
      type: "response",
      ...input
    }
  );

  if (!response.ok) {
    throw new Error("Failed to save participant response.");
  }
}

export async function updateRecordingState(
  token: string,
  input: {
    attemptNumber?: number;
    microphonePermission?:
      | "not_requested"
      | "requesting"
      | "granted"
      | "denied"
      | "cancelled"
      | "unavailable";
    screenPermission?:
      | "not_requested"
      | "requesting"
      | "granted"
      | "denied"
      | "cancelled"
      | "unavailable";
    recordingStatus?:
      | "not_started"
      | "starting"
      | "active"
      | "stopping"
      | "stopped"
      | "failed";
    uploadStatus?: "not_started" | "pending" | "in_progress" | "complete" | "failed";
  }
) {
  const response = await postRuntimeJson(
    buildAttemptScopedUrl(token, "runtime", input.attemptNumber),
    {
      type: "recording_state",
      ...input
    }
  );

  if (!response.ok) {
    throw new Error("Failed to update recording state.");
  }
}

// Progress of the blob body transfer only. Reaching 100 here does not mean the
// recording is durably stored - finalization happens after the body lands.
export interface UploadProgressEvent {
  loadedBytes: number;
  totalBytes: number;
  percentage: number;
}

type UploadRecordingAssetInput = {
  attemptNumber?: number;
  blob: Blob;
  directRecordingUploadMode: DirectRecordingUploadMode;
  fileName: string;
  mimeType: string;
  durationSeconds: number | null;
  onUploadProgress?: (event: UploadProgressEvent) => void;
};

export async function uploadRecordingAsset(
  token: string,
  input: UploadRecordingAssetInput
) {
  switch (input.directRecordingUploadMode) {
    case "s3":
      return uploadRecordingAssetDirectlyToS3(token, input);
    default:
      return uploadRecordingAssetViaServer(token, input);
  }
}

async function uploadRecordingAssetDirectlyToS3(
  token: string,
  input: UploadRecordingAssetInput
) {
  const normalizedMimeType = normalizeRecordingMimeType(input.mimeType);
  const prepareResponse = await postRuntimeJson(
    buildAttemptScopedUrl(token, "recording/client-upload", input.attemptNumber),
    {
      durationSeconds: input.durationSeconds,
      fileName: input.fileName,
      fileSizeBytes: input.blob.size,
      mimeType: normalizedMimeType
    }
  );

  if (!prepareResponse.ok) {
    throw new Error("Failed to prepare the direct recording upload.");
  }

  const { uploadUrl, objectKey } = (await prepareResponse.json()) as {
    uploadUrl: string;
    objectKey: string;
  };

  // Single PUT by design: the 2GB recording cap sits comfortably under S3's
  // 5GB single-PUT limit, and multipart would need three more presigned
  // endpoints. Revisit only if the cap ever rises. Cross-origin to S3: no
  // cookies, no CSRF header - only the content type the presign was signed for.
  const putResponse = await sendBlobWithProgress({
    url: uploadUrl,
    method: "PUT",
    headers: {
      "Content-Type": normalizedMimeType
    },
    blob: input.blob,
    onProgress: input.onUploadProgress
  });

  if (!putResponse.ok) {
    throw new Error("Failed to upload the recording to object storage.");
  }

  const finalizeResponse = await postRuntimeJson(
    // The "recording/finalize" argument below is a URL path segment, not a
    // credential; gitleaks' generic-api-key heuristic misreads `token, "..."`.
    buildAttemptScopedUrl(token, "recording/finalize", input.attemptNumber), // gitleaks:allow
    {
      durationSeconds: input.durationSeconds,
      objectKey
    }
  );

  if (!finalizeResponse.ok) {
    throw new Error("Failed to finalize the recording asset after direct upload.");
  }

  return (await finalizeResponse.json()) as {
    id: string;
    relativePath: string;
    fileSizeBytes: number;
    mimeType: string;
  };
}

async function uploadRecordingAssetViaServer(
  token: string,
  input: UploadRecordingAssetInput
) {
  const normalizedMimeType = normalizeRecordingMimeType(input.mimeType);
  const csrfToken = await ensureCsrfToken();
  const upload = () =>
    sendBlobWithProgress({
      url: buildAttemptScopedUrl(token, "recording", input.attemptNumber),
      method: "POST",
      withCredentials: true,
      headers: {
        "Content-Type": normalizedMimeType,
        "X-Firsthand-Duration-Seconds":
          input.durationSeconds === null ? "" : String(input.durationSeconds),
        "X-Firsthand-File-Name": encodeURIComponent(input.fileName),
        "X-Firsthand-Mime-Type": normalizedMimeType,
        ...(csrfToken ? { [CSRF_HEADER]: csrfToken } : {})
      },
      blob: input.blob,
      onProgress: input.onUploadProgress
    });

  let response = await upload();

  // A CSRF 403 on the same-origin server-proxied route: refresh the token once
  // and retry, matching the axios interceptor's contract.
  if (response.status === 403 && isCsrfRejectionText(response.responseText)) {
    const refreshed = await ensureCsrfToken(true);

    response = await sendBlobWithProgress({
      url: buildAttemptScopedUrl(token, "recording", input.attemptNumber),
      method: "POST",
      withCredentials: true,
      headers: {
        "Content-Type": normalizedMimeType,
        "X-Firsthand-Duration-Seconds":
          input.durationSeconds === null ? "" : String(input.durationSeconds),
        "X-Firsthand-File-Name": encodeURIComponent(input.fileName),
        "X-Firsthand-Mime-Type": normalizedMimeType,
        ...(refreshed ? { [CSRF_HEADER]: refreshed } : {})
      },
      blob: input.blob,
      onProgress: input.onUploadProgress
    });
  }

  if (!response.ok) {
    throw new Error("Failed to upload the recording asset.");
  }

  return JSON.parse(response.responseText) as {
    id: string;
    relativePath: string;
    fileSizeBytes: number;
    mimeType: string;
  };
}

function isCsrfRejectionText(responseText: string): boolean {
  try {
    const data = JSON.parse(responseText) as { code?: string };
    return data?.code === CSRF_ERROR_CODE;
  } catch {
    return false;
  }
}

/**
 * Sends a blob over XMLHttpRequest so upload progress can be observed - fetch
 * has no upload progress API. Mirrors fetch's failure contract: resolves with
 * the response status for the caller to judge, rejects only when the transfer
 * itself breaks.
 */
export function sendBlobWithProgress(input: {
  url: string;
  method: "PUT" | "POST";
  blob: Blob;
  headers?: Record<string, string>;
  withCredentials?: boolean;
  onProgress?: (event: UploadProgressEvent) => void;
}): Promise<{ status: number; ok: boolean; responseText: string }> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();

    request.open(input.method, input.url);

    if (input.withCredentials) {
      request.withCredentials = true;
    }

    for (const [name, value] of Object.entries(input.headers ?? {})) {
      request.setRequestHeader(name, value);
    }

    request.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) {
        return;
      }

      input.onProgress?.({
        loadedBytes: event.loaded,
        totalBytes: event.total,
        percentage: event.total > 0 ? (event.loaded / event.total) * 100 : 0
      });
    });

    request.addEventListener("load", () => {
      resolve({
        status: request.status,
        ok: request.status >= 200 && request.status < 300,
        responseText: request.responseText
      });
    });

    request.addEventListener("error", () => {
      reject(new Error("The recording upload failed because of a network error."));
    });
    request.addEventListener("abort", () => {
      reject(new Error("The recording upload was aborted."));
    });
    // No request.timeout is set deliberately: a fixed total-duration timeout
    // would kill legitimate large uploads on slow links, matching the previous
    // fetch behaviour. A dead transfer surfaces as a network error instead.

    request.send(input.blob);
  });
}

function buildAttemptScopedUrl(
  token: string,
  path: "runtime" | "recording" | "recording/client-upload" | "recording/finalize",
  attemptNumber?: number
) {
  const query = attemptNumber ? `?attempt=${encodeURIComponent(String(attemptNumber))}` : "";

  return `${getApiBaseUrl()}/api/firsthand/session/${encodeURIComponent(token)}/${path}${query}`;
}
