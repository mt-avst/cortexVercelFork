export type SetupCheckStatus = "pass" | "fail" | "warning";

export type SetupCheckId =
  | "browser"
  | "viewport"
  | "microphone"
  | "screen_share";

export type SetupCheck = {
  id: SetupCheckId;
  label: string;
  status: SetupCheckStatus;
  detail: string;
  remediation?: string;
};

export type SetupSnapshot = {
  userAgent: string;
  viewportWidth: number;
  hasMediaDevices: boolean;
  hasEnumerateDevices: boolean;
  hasGetUserMedia: boolean;
  hasGetDisplayMedia: boolean;
  audioInputCount: number | null;
  deviceEnumerationFailed: boolean;
};

export type SetupAssessment = {
  checks: SetupCheck[];
  canProceed: boolean;
  failedChecks: number;
  warningChecks: number;
  summary: string;
};

const minimumViewportWidth = 1024;

export async function collectSetupSnapshot(): Promise<SetupSnapshot> {
  const mediaDevices = navigator.mediaDevices;
  let audioInputCount: number | null = null;
  let deviceEnumerationFailed = false;

  if (mediaDevices?.enumerateDevices) {
    try {
      const devices = await mediaDevices.enumerateDevices();

      audioInputCount = devices.filter(
        (device) => device.kind === "audioinput"
      ).length;
    } catch {
      deviceEnumerationFailed = true;
    }
  }

  return {
    userAgent: navigator.userAgent,
    viewportWidth: window.innerWidth,
    hasMediaDevices: Boolean(mediaDevices),
    hasEnumerateDevices: Boolean(mediaDevices?.enumerateDevices),
    hasGetUserMedia: Boolean(mediaDevices?.getUserMedia),
    hasGetDisplayMedia: Boolean(mediaDevices?.getDisplayMedia),
    audioInputCount,
    deviceEnumerationFailed
  };
}

export function assessSetupReadiness(
  snapshot: SetupSnapshot
): SetupAssessment {
  const checks: SetupCheck[] = [
    assessBrowser(snapshot),
    assessViewport(snapshot),
    assessMicrophone(snapshot),
    assessScreenShare(snapshot)
  ];

  const failedChecks = checks.filter((check) => check.status === "fail").length;
  const warningChecks = checks.filter(
    (check) => check.status === "warning"
  ).length;
  const canProceed = failedChecks === 0;

  return {
    checks,
    canProceed,
    failedChecks,
    warningChecks,
    summary: buildSummary(failedChecks, warningChecks)
  };
}

function assessBrowser(snapshot: SetupSnapshot): SetupCheck {
  const family = detectBrowserFamily(snapshot.userAgent);

  if (family === "unsupported") {
    return {
      id: "browser",
      label: "Your browser",
      status: "fail",
      detail:
        "This browser cannot run a recorded session",
      remediation:
        "Open your invitation link in the latest version of Chrome, Edge, Arc, Opera or Firefox on a laptop or desktop."
    };
  }

  return {
    id: "browser",
    label: "Your browser",
    status: "pass",
    detail: `${family} works for this session`
  };
}

function assessViewport(snapshot: SetupSnapshot): SetupCheck {
  if (snapshot.viewportWidth < minimumViewportWidth) {
    return {
      id: "viewport",
      label: "Window size",
      status: "fail",
      detail: "This window is too narrow to run the session",
      remediation:
        "Use a laptop or desktop, and make the browser window wider, then check again."
    };
  }

  return {
    id: "viewport",
    label: "Window size",
    status: "pass",
    detail: "Your window is big enough"
  };
}

function assessMicrophone(snapshot: SetupSnapshot): SetupCheck {
  if (!snapshot.hasMediaDevices || !snapshot.hasGetUserMedia) {
    return {
      id: "microphone",
      label: "Microphone",
      status: "fail",
      detail: "This browser cannot use a microphone",
      remediation:
        "Open your invitation link in Chrome, Edge, Arc, Opera or Firefox on a laptop or desktop."
    };
  }

  if (snapshot.audioInputCount === 0) {
    return {
      id: "microphone",
      label: "Microphone",
      status: "fail",
      detail: "We could not find a microphone",
      remediation:
        "Plug in or switch on a microphone, then check again."
    };
  }

  if (
    snapshot.hasEnumerateDevices &&
    snapshot.audioInputCount === null &&
    snapshot.deviceEnumerationFailed
  ) {
    return {
      id: "microphone",
      label: "Microphone",
      status: "warning",
      detail:
        "Your browser can use a microphone, but we could not confirm which one yet",
      remediation:
        "Keep your microphone connected. You will be asked to allow access when the session starts."
    };
  }

  return {
    id: "microphone",
    label: "Microphone",
    status: "pass",
    detail: "A microphone is ready"
  };
}

function assessScreenShare(snapshot: SetupSnapshot): SetupCheck {
  if (!snapshot.hasMediaDevices || !snapshot.hasGetDisplayMedia) {
    return {
      id: "screen_share",
      label: "Screen sharing",
      status: "fail",
      detail:
        "This browser cannot share your screen",
      remediation:
        "Open your invitation link in Chrome, Edge, Arc, Opera or Firefox on a laptop or desktop."
    };
  }

  return {
    id: "screen_share",
    label: "Screen sharing",
    status: "pass",
    detail: "Screen sharing is ready"
  };
}

function detectBrowserFamily(userAgent: string) {
  const isFirefox = /Firefox/i.test(userAgent);
  const isEdge = /Edg/i.test(userAgent);
  const isOpera = /OPR/i.test(userAgent);
  const isArc = /Arc/i.test(userAgent);
  const isChrome = /Chrome|Chromium/i.test(userAgent) && !isEdge && !isOpera;
  const isSafari =
    /Safari/i.test(userAgent) &&
    !/Chrome|Chromium|CriOS|Edg|OPR|Arc/i.test(userAgent);

  if (isEdge) {
    return "Edge";
  }

  if (isOpera) {
    return "Opera";
  }

  if (isArc) {
    return "Arc";
  }

  if (isChrome) {
    return "Chrome";
  }

  if (isFirefox) {
    return "Firefox";
  }

  if (isSafari) {
    return "unsupported";
  }

  return "unsupported";
}

function buildSummary(failedChecks: number, warningChecks: number) {
  if (failedChecks > 0) {
    return `${failedChecks} thing${failedChecks === 1 ? " needs" : "s need"} fixing before you can start. See below.`;
  }

  if (warningChecks > 0) {
    return `You are ready to start${warningChecks > 0 ? ", with one thing to keep an eye on" : ""}.`;
  }

  return "Everything is ready.";
}
