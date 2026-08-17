import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PipTrustHeader } from "../PipTrustHeader";

// Three states, not two. The panel used to render "not started yet" in the
// same danger red as "your recording has stopped", which spends the alarm
// colour on the resting state - so by the time something is actually wrong
// the participant has been looking at red for minutes and it reads as decor.

describe("PipTrustHeader recording state", () => {
  it("is quiet before anything has started", () => {
    render(<PipTrustHeader state="idle" />);

    const indicator = screen.getByText("Not recording");

    expect(indicator).toBeVisible();
    // Muted, never the danger colour: nothing has gone wrong yet.
    expect(indicator.className).toContain("is-idle");
    expect(indicator.className).not.toContain("is-stopped");
  });

  it("marks a live recording with the dot", () => {
    render(<PipTrustHeader state="live" />);

    const indicator = screen.getByText(/Recording/);

    expect(indicator.className).toContain("is-live");
    expect(indicator.querySelector(".recording-dot")).not.toBeNull();
  });

  it("keeps the alarm for a recording that stopped mid-session", () => {
    render(<PipTrustHeader state="stopped" />);

    const indicator = screen.getByText("Recording stopped");

    expect(indicator.className).toContain("is-stopped");
    // The one state that earns the danger colour is the one where the
    // participant is still working but nothing is being captured.
    expect(indicator.className).not.toContain("is-idle");
  });

  it("never carries researcher-authored content", () => {
    const { container } = render(<PipTrustHeader state="live" />);

    // The strip is an anti-phishing control: wordmark and recorder state
    // only. If this ever accepts a prop that renders authored text, the
    // control is gone.
    expect(container.textContent).toBe("Cortex" + "Recording");
  });
});
