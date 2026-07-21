export type DeviceSnapshot = {
  userAgent: string;
  viewportWidth: number;
  hasGetDisplayMedia: boolean;
};

export type DeviceSupport = {
  canRun: boolean;
  reason: string | null;
};

const minimumViewportWidth = 1024;
const supported: DeviceSupport = { canRun: true, reason: null };

/**
 * Whether this device can run a recorded session at all.
 *
 * Deliberately a subset of the full setup checks, and knowable immediately: it
 * gates the welcome stage so a participant is not asked to consent to screen
 * and microphone recording on a device that can never do it. Previously the
 * only device gate was inside the setup checks, three of five steps in and
 * after consent - and its remediation ("use a laptop or desktop") is not
 * something a phone user can act on.
 */
export function assessDeviceSupport(
  snapshot: DeviceSnapshot | null
): DeviceSupport {
  // Nothing is knowable before hydration; never flash a blocker on a good
  // machine while waiting to find out.
  if (!snapshot) {
    return supported;
  }

  if (isMobileUserAgent(snapshot.userAgent)) {
    return {
      canRun: false,
      reason:
        "This session records your screen, which phones and tablets cannot do. Open your invitation link on a laptop or desktop."
    };
  }

  if (!snapshot.hasGetDisplayMedia) {
    return {
      canRun: false,
      reason:
        "This browser cannot share your screen. Open your invitation link in the latest Chrome, Edge, Arc, Opera or Firefox."
    };
  }

  if (snapshot.viewportWidth < minimumViewportWidth) {
    return {
      canRun: false,
      reason:
        "This browser window is too narrow for the session. Make it wider, then reload this page."
    };
  }

  return supported;
}

export function collectDeviceSnapshot(): DeviceSnapshot {
  return {
    userAgent: navigator.userAgent,
    viewportWidth: window.innerWidth,
    hasGetDisplayMedia: Boolean(navigator.mediaDevices?.getDisplayMedia)
  };
}

function isMobileUserAgent(userAgent: string) {
  return /Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(userAgent);
}
