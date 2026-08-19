import { useEffect, useRef, useState } from "react";

import {
  type DirectRecordingUploadMode,
  type UploadProgressEvent,
  sendRuntimeEvent,
  updateRecordingState,
  uploadRecordingAsset
} from "./runtime-client";

type RefHandle<T> = {
  current: T | null;
};

// getDisplayMedia's picker-shaping options are Chromium-supported but not yet
// in every lib.dom.d.ts we build against. We already gate the session to
// Chrome, so relying on them is safe; this keeps the call type-checked without
// an untyped `any`.
type ExtendedDisplayMediaOptions = DisplayMediaStreamOptions & {
  selfBrowserSurface?: "include" | "exclude";
  surfaceSwitching?: "include" | "exclude";
  monitorTypeSurfaces?: "include" | "exclude";
};

export type RecorderState = {
  captureStoppedExternally: boolean;
  microphonePermission:
    | "not_requested"
    | "requesting"
    | "granted"
    | "denied"
    | "cancelled"
    | "unavailable";
  screenPermission:
    | "not_requested"
    | "requesting"
    | "granted"
    | "denied"
    | "cancelled"
    | "unavailable";
  recordingStatus:
    | "not_started"
    | "starting"
    | "active"
    | "stopping"
    | "stopped"
    | "failed";
  uploadStatus: "not_started" | "pending" | "in_progress" | "complete" | "failed";
  // Last known progress of the current or most recent upload attempt. Held
  // through a failure so the UI can show how far the attempt got.
  uploadProgress: UploadProgressEvent | null;
  // Epoch milliseconds of the instant recording started, aligned with the
  // duration calculation. Survives stop and upload so banners can keep showing
  // elapsed time.
  recordingStartedAt: number | null;
  errorMessage: string | null;
  durationSeconds: number | null;
  asset: {
    assetId: string;
    relativePath: string;
    fileSizeBytes: number;
    mimeType: string;
  } | null;
};

type PendingRecordingUpload = {
  blob: Blob;
  durationSeconds: number | null;
  fileName: string;
  mimeType: string;
};

type CaptureLifecycle = Pick<RecorderState, "recordingStatus" | "uploadStatus">;

/**
 * Whether leaving the page right now would destroy the participant's session.
 *
 * A recording exists only as in-memory chunks until its upload lands: nothing
 * is written to disk, and nothing is streamed incrementally. So any unload
 * between pressing start and the upload completing throws the whole session
 * away, after the participant has already sat through it.
 */
export function shouldGuardNavigation(state: CaptureLifecycle) {
  const isCapturing =
    state.recordingStatus === "starting" ||
    state.recordingStatus === "active" ||
    state.recordingStatus === "stopping";
  const isUploading =
    state.uploadStatus === "pending" || state.uploadStatus === "in_progress";
  // A failed upload still holds the only copy, and is retryable - see
  // canRetryRecordingUpload. Leaving now discards it.
  const isRetryable = state.uploadStatus === "failed";

  return isCapturing || isUploading || isRetryable;
}

/**
 * Whether the participant can be offered another attempt at a failed upload.
 * Requires the captured blob to still be held in memory.
 */
export function canRetryRecordingUpload(
  state: Pick<RecorderState, "uploadStatus">,
  hasPendingRecording: boolean
) {
  return state.uploadStatus === "failed" && hasPendingRecording;
}

const initialRecorderState: RecorderState = {
  captureStoppedExternally: false,
  microphonePermission: "not_requested",
  screenPermission: "not_requested",
  recordingStatus: "not_started",
  uploadStatus: "not_started",
  uploadProgress: null,
  recordingStartedAt: null,
  errorMessage: null,
  durationSeconds: null,
  asset: null
};

/**
 * Derives the upload progress the UI should hold while an upload is in flight.
 *
 * The percentage is floored to a whole number so callers can skip state
 * updates that would not change what the participant sees, and capped at 99
 * because transport-level progress covers only the blob body - 100 is reserved
 * for the moment the finalize step confirms the recording is durably stored.
 */
export function deriveUploadProgress(
  event: UploadProgressEvent
): UploadProgressEvent {
  return {
    ...event,
    percentage: Math.min(99, Math.max(0, Math.floor(event.percentage)))
  };
}

export function useSessionRecorder(
  token: string,
  options: {
    attemptNumber: number;
    directRecordingUploadMode: DirectRecordingUploadMode;
  }
) {
  const [state, setState] = useState<RecorderState>(initialRecorderState);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const microphoneStreamRef = useRef<MediaStream | null>(null);
  const combinedStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const startedAtRef = useRef<number | null>(null);
  const stopInFlightRef = useRef(false);
  // Last whole-number percentage pushed into state. Transport progress events
  // fire far more often than the display changes; this keeps renders down to
  // one per visible percentage step.
  const lastUploadProgressPercentageRef = useRef<number | null>(null);
  // Holds the captured recording between a failed upload and a retry. This is
  // the only copy: without it, a transient network failure loses the session.
  const pendingUploadRef = useRef<PendingRecordingUpload | null>(null);

  useEffect(() => {
    return () => {
      releaseCaptureResources({
        combinedStreamRef,
        displayStreamRef,
        mediaRecorderRef,
        microphoneStreamRef
      });
    };
  }, []);

  async function startCapture() {
    setState((current) => ({
      ...current,
      captureStoppedExternally: false,
      microphonePermission: "requesting",
      screenPermission: "not_requested",
      recordingStatus: "starting",
      uploadProgress: null,
      recordingStartedAt: null,
      errorMessage: null
    }));

    // Recording-state mirrors are audit telemetry throughout this hook: they
    // are sent best-effort because a failed POST must never abort a healthy
    // capture or misclassify it as a permission failure.
    void updateRecordingState(token, {
      attemptNumber: options.attemptNumber,
      microphonePermission: "requesting",
      screenPermission: "not_requested",
      recordingStatus: "starting"
    }).catch(() => null);

    let displayStream: MediaStream | null = null;
    let microphoneStream: MediaStream | null = null;
    let combinedStream: MediaStream | null = null;

    try {
      microphoneStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false
      });
      microphoneStreamRef.current = microphoneStream;

      setState((current) => ({
        ...current,
        captureStoppedExternally: false,
        microphonePermission: "granted",
        screenPermission: "requesting",
        recordingStatus: "starting",
        errorMessage: null
      }));

      void updateRecordingState(token, {
        attemptNumber: options.attemptNumber,
        microphonePermission: "granted",
        screenPermission: "requesting",
        recordingStatus: "starting"
      }).catch(() => null);

      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: 30
        },
        audio: false,
        // Shape the picker so the right choice is the easy one. Excluding this
        // tab removes the instruction page from the list, so the participant
        // cannot record it instead of the task window they just opened.
        // surfaceSwitching lets them swap the shared surface mid-session
        // without a re-prompt. monitorTypeSurfaces keeps "entire screen"
        // available as the safety net when they cannot find the window.
        selfBrowserSurface: "exclude",
        surfaceSwitching: "include",
        monitorTypeSurfaces: "include"
      } as ExtendedDisplayMediaOptions);
      displayStreamRef.current = displayStream;
      // What surface they actually shared (window / monitor / browser tab).
      // Best-effort telemetry only: it tells us whether the picker guidance is
      // landing, and never gates the capture.
      const sharedSurface =
        displayStream.getVideoTracks()[0]?.getSettings().displaySurface ?? null;
      displayStream.getVideoTracks()[0]?.addEventListener(
        "ended",
        () => {
          if (!stopInFlightRef.current) {
            void stopCaptureAndUpload({
              captureStoppedExternally: true
            }).catch(() => {
              // The runner will surface the upload failure state after the stop attempt.
            });
          }
        },
        { once: true }
      );

      combinedStream = new MediaStream([
        ...displayStream.getVideoTracks(),
        ...microphoneStream.getAudioTracks()
      ]);

      combinedStreamRef.current = combinedStream;

      const mimeType = getPreferredMimeType();
      const recorder = mimeType
        ? new MediaRecorder(combinedStream, { mimeType })
        : new MediaRecorder(combinedStream);

      chunksRef.current = [];
      // One instant for both: recordingStartedAt in state must agree with the
      // ref used for the duration calculation.
      const startedAt = Date.now();
      startedAtRef.current = startedAt;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };
      recorder.onerror = () => {
        setState((current) => ({
          ...current,
          recordingStatus: "failed",
          errorMessage:
            "Recording stopped unexpectedly. Retry the start step to capture a clean session."
        }));
        void updateRecordingState(token, {
          attemptNumber: options.attemptNumber,
          recordingStatus: "failed"
        }).catch(() => null);
        void sendRuntimeEvent(token, {
          attemptNumber: options.attemptNumber,
          eventType: "recording_failed"
        }).catch(() => null);
      };
      recorder.start(1000);
      mediaRecorderRef.current = recorder;

      setState((current) => ({
        ...current,
        microphonePermission: "granted",
        screenPermission: "granted",
        recordingStatus: "active",
        uploadStatus: "not_started",
        recordingStartedAt: startedAt,
        errorMessage: null
      }));

      void updateRecordingState(token, {
        attemptNumber: options.attemptNumber,
        microphonePermission: "granted",
        screenPermission: "granted",
        recordingStatus: "active",
        uploadStatus: "not_started"
      }).catch(() => null);
      void sendRuntimeEvent(token, {
        attemptNumber: options.attemptNumber,
        eventType: "recording_started",
        metadata: sharedSurface ? { displaySurface: sharedSurface } : undefined
      }).catch(() => null);

      return true;
    } catch (error) {
      const permissions = classifyPermissionError(
        error,
        microphoneStream ? "screen" : "microphone"
      );

      setState((current) => ({
        ...current,
        captureStoppedExternally: false,
        microphonePermission: permissions.microphonePermission,
        screenPermission: permissions.screenPermission,
        recordingStatus: "not_started",
        errorMessage: permissions.message
      }));

      void updateRecordingState(token, {
        attemptNumber: options.attemptNumber,
        microphonePermission: permissions.microphonePermission,
        screenPermission: permissions.screenPermission,
        recordingStatus: "not_started"
      }).catch(() => null);

      releaseCaptureResources(
        {
          combinedStreamRef,
          displayStreamRef,
          mediaRecorderRef,
          microphoneStreamRef
        },
        {
          combinedStream,
          displayStream,
          microphoneStream
        }
      );

      return false;
    }
  }

  /**
   * Uploads the held recording. Shared by the initial attempt and any retry, so
   * both record the same runtime events and land in the same state. The blob is
   * kept in pendingUploadRef until it is safely stored.
   */
  async function uploadPendingRecording(captureStoppedExternally: boolean) {
    const pending = pendingUploadRef.current;

    if (!pending) {
      throw new Error("No recording is held for upload.");
    }

    try {
      // Audit telemetry must never block or fail the upload itself: a failed
      // POST here would show "Upload interrupted" before a byte was sent.
      void sendRuntimeEvent(token, {
        attemptNumber: options.attemptNumber,
        eventType: "upload_started"
      }).catch(() => null);
      void updateRecordingState(token, {
        attemptNumber: options.attemptNumber,
        recordingStatus: "stopped",
        uploadStatus: "in_progress"
      }).catch(() => null);

      lastUploadProgressPercentageRef.current = 0;
      setState((current) => ({
        ...current,
        uploadStatus: "in_progress",
        uploadProgress: {
          loadedBytes: 0,
          totalBytes: pending.blob.size,
          percentage: 0
        },
        errorMessage: null
      }));

      const uploaded = await uploadRecordingAsset(token, {
        attemptNumber: options.attemptNumber,
        blob: pending.blob,
        directRecordingUploadMode: options.directRecordingUploadMode,
        durationSeconds: pending.durationSeconds,
        fileName: pending.fileName,
        mimeType: pending.mimeType,
        onUploadProgress: (event) => {
          const progress = deriveUploadProgress(event);

          if (progress.percentage === lastUploadProgressPercentageRef.current) {
            return;
          }

          lastUploadProgressPercentageRef.current = progress.percentage;
          setState((current) => ({
            ...current,
            uploadProgress: progress
          }));
        }
      });

      const asset = {
        assetId: uploaded.id,
        relativePath: uploaded.relativePath,
        fileSizeBytes: uploaded.fileSizeBytes,
        mimeType: uploaded.mimeType
      };

      // Only release the blob once it is durably stored.
      pendingUploadRef.current = null;
      chunksRef.current = [];

      setState((current) => ({
        ...current,
        captureStoppedExternally,
        recordingStatus: "stopped",
        uploadStatus: "complete",
        // 100 only now: the finalize step has confirmed durable storage, which
        // transport-level progress alone can never assert.
        uploadProgress: {
          loadedBytes: pending.blob.size,
          totalBytes: pending.blob.size,
          percentage: 100
        },
        durationSeconds: pending.durationSeconds,
        asset
      }));

      // The asset is durably stored at this point: the completion events are
      // best-effort so a telemetry blip cannot misreport a stored recording as
      // failed and provoke a duplicate re-upload on retry.
      void sendRuntimeEvent(token, {
        attemptNumber: options.attemptNumber,
        eventType: "upload_completed"
      }).catch(() => null);
      void updateRecordingState(token, {
        attemptNumber: options.attemptNumber,
        recordingStatus: "stopped",
        uploadStatus: "complete"
      }).catch(() => null);

      return asset;
    } catch (error) {
      void sendRuntimeEvent(token, {
        attemptNumber: options.attemptNumber,
        eventType: "upload_failed"
      }).catch(() => null);
      void updateRecordingState(token, {
        attemptNumber: options.attemptNumber,
        recordingStatus: "stopped",
        uploadStatus: "failed"
      }).catch(() => null);

      // pendingUploadRef is deliberately left populated so the participant can
      // try again rather than losing the session to a transient failure.
      setState((current) => ({
        ...current,
        captureStoppedExternally,
        recordingStatus: "stopped",
        uploadStatus: "failed",
        errorMessage:
          "Your recording is safe on this device, but the upload did not finish. Stay on this page and try again."
      }));

      throw error;
    }
  }

  async function retryUpload() {
    if (!canRetryRecordingUpload(state, Boolean(pendingUploadRef.current))) {
      return state.asset;
    }

    return uploadPendingRecording(state.captureStoppedExternally).catch(
      () => null
    );
  }

  async function stopCaptureAndUpload(input?: {
    captureStoppedExternally?: boolean;
  }) {
    const recorder = mediaRecorderRef.current;
    const captureStoppedExternally = input?.captureStoppedExternally ?? false;

    if (!recorder || recorder.state === "inactive" || stopInFlightRef.current) {
      return state.asset;
    }

    stopInFlightRef.current = true;

    setState((current) => ({
      ...current,
      captureStoppedExternally,
      recordingStatus: "stopping",
      uploadStatus: "pending",
      errorMessage: null
    }));

    void updateRecordingState(token, {
      attemptNumber: options.attemptNumber,
      recordingStatus: "stopping",
      uploadStatus: "pending"
    }).catch(() => null);

    try {
      const uploadResult = await new Promise<RecorderState["asset"]>(
        (resolve, reject) => {
          recorder.onstop = async () => {
            releaseCaptureResources({
              combinedStreamRef,
              displayStreamRef,
              mediaRecorderRef,
              microphoneStreamRef
            });

            const blob = new Blob(chunksRef.current, {
              type: recorder.mimeType || "video/webm"
            });

            const durationSeconds = startedAtRef.current
              ? Number(((Date.now() - startedAtRef.current) / 1000).toFixed(1))
              : null;

            // Hold the capture before attempting the upload, so a failure is
            // retryable rather than terminal.
            pendingUploadRef.current = {
              blob,
              durationSeconds,
              fileName: `session-${Date.now()}.webm`,
              mimeType: blob.type || "video/webm"
            };

            void sendRuntimeEvent(token, {
              attemptNumber: options.attemptNumber,
              eventType: "recording_stopped"
            }).catch(() => null);

            try {
              resolve(await uploadPendingRecording(captureStoppedExternally));
            } catch {
              reject(new Error("Recording upload failed."));
            }
          };

          recorder.stop();
        }
      );

      return uploadResult;
    } finally {
      stopInFlightRef.current = false;
    }
  }

  return {
    canRetryUpload: canRetryRecordingUpload(
      state,
      Boolean(pendingUploadRef.current)
    ),
    retryUpload,
    state,
    startCapture,
    stopCaptureAndUpload
  };
}

export function classifyPermissionError(
  error: unknown,
  stage: "microphone" | "screen"
) {
  const domError = error as DOMException | undefined;
  const errorName = domError?.name ?? "";

  if (errorName === "NotAllowedError") {
    if (stage === "microphone") {
      return {
        microphonePermission: "denied" as const,
        screenPermission: "not_requested" as const,
        message:
          "Microphone permission was denied. Allow microphone access on this tab before choosing what to share."
      };
    }

    return {
      microphonePermission: "granted" as const,
      screenPermission: "denied" as const,
      message:
        "Screen sharing was denied after microphone access was granted. Choose a screen or window and retry."
    };
  }

  if (errorName === "AbortError") {
    if (stage === "microphone") {
      return {
        microphonePermission: "cancelled" as const,
        screenPermission: "not_requested" as const,
        message:
          "Microphone access was cancelled before screen sharing began. Retry when you are ready to allow the prompt on this tab."
      };
    }

    return {
      microphonePermission: "granted" as const,
      screenPermission: "cancelled" as const,
      message:
        "Screen sharing was cancelled after microphone access was granted. Retry when you are ready to choose what to share."
    };
  }

  return {
    microphonePermission:
      stage === "microphone" ? ("unavailable" as const) : ("granted" as const),
    screenPermission:
      stage === "screen" ? ("unavailable" as const) : ("not_requested" as const),
    message:
      stage === "microphone"
        ? "This browser could not start microphone capture. Use a supported desktop browser and retry."
        : "This browser could not start screen sharing after microphone access was granted. Use a supported desktop browser and retry."
  };
}

function getPreferredMimeType() {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm"
  ];

  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

function stopTracks(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}

export function releaseCaptureResources(
  refs: {
    displayStreamRef: RefHandle<MediaStream>;
    microphoneStreamRef: RefHandle<MediaStream>;
    combinedStreamRef: RefHandle<MediaStream>;
    mediaRecorderRef?: RefHandle<MediaRecorder>;
  },
  acquired: {
    displayStream?: MediaStream | null;
    microphoneStream?: MediaStream | null;
    combinedStream?: MediaStream | null;
  } = {}
) {
  stopTracks(refs.displayStreamRef.current ?? acquired.displayStream ?? null);
  stopTracks(refs.microphoneStreamRef.current ?? acquired.microphoneStream ?? null);
  stopTracks(refs.combinedStreamRef.current ?? acquired.combinedStream ?? null);

  refs.displayStreamRef.current = null;
  refs.microphoneStreamRef.current = null;
  refs.combinedStreamRef.current = null;

  if (refs.mediaRecorderRef) {
    refs.mediaRecorderRef.current = null;
  }
}
