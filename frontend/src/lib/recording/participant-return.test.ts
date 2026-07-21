import { describe, expect, it } from "vitest";

import { buildParticipantReturnUrl } from "./participant-return";

describe("buildParticipantReturnUrl", () => {
  it("marks a completed session as completed", () => {
    const url = buildParticipantReturnUrl(
      "https://cortex.example/opportunities/abc?completed=1",
      "completed"
    );

    expect(new URL(url).searchParams.get("completed")).toBe("1");
    expect(new URL(url).searchParams.get("firsthand_outcome")).toBe("completed");
  });

  it("does not tell the sender a declined session completed", () => {
    // Cortex bakes `?completed=1` into return_url up front and its
    // OpportunityDetail page shows a completion banner off
    // `searchParams.get('completed') === '1'`. Returning there from the declined
    // phase would otherwise show the participant "Session complete".
    const url = buildParticipantReturnUrl(
      "https://cortex.example/opportunities/abc?completed=1",
      "declined"
    );

    expect(new URL(url).searchParams.has("completed")).toBe(false);
    expect(new URL(url).searchParams.get("firsthand_outcome")).toBe("declined");
  });

  it("keeps every other query parameter the sender set", () => {
    const url = buildParticipantReturnUrl(
      "https://cortex.example/opportunities/abc?completed=1&ref=email&utm_source=x",
      "declined"
    );
    const params = new URL(url).searchParams;

    expect(params.get("ref")).toBe("email");
    expect(params.get("utm_source")).toBe("x");
  });

  it("handles a return url with no query string", () => {
    const url = buildParticipantReturnUrl(
      "https://cortex.example/opportunities/abc",
      "declined"
    );

    expect(url).not.toBeNull();
    expect(new URL(url!).searchParams.get("firsthand_outcome")).toBe("declined");
    expect(new URL(url!).pathname).toBe("/opportunities/abc");
  });

  it("drops an unparsable url rather than rendering a broken href", () => {
    expect(buildParticipantReturnUrl("not a url", "completed")).toBeNull();
  });

  it("rejects a javascript: return url so it never reaches an href", () => {
    // The contract validates return_url only as z.string().url(), which accepts
    // javascript:/data:. This is the sink-side guard: a non-http(s) scheme is
    // dropped so the "Return to the study hub" anchor is never rendered with it.
    expect(
      buildParticipantReturnUrl("javascript:alert(document.cookie)", "completed")
    ).toBeNull();
    expect(
      buildParticipantReturnUrl("data:text/html,<script>1</script>", "declined")
    ).toBeNull();
  });
});
