import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionPayload, StudyStep } from "../../../shared/firsthand/contract";
import { SurveyRunner } from "../SurveyRunner";

const saveParticipantResponse = vi.fn();
const sendRuntimeEvent = vi.fn();

vi.mock("../../../lib/recording/runtime-client", () => ({
  saveParticipantResponse: (...args: unknown[]) =>
    saveParticipantResponse(...args),
  sendRuntimeEvent: (...args: unknown[]) => sendRuntimeEvent(...args)
}));

const payloadWith = (steps: Partial<StudyStep>[]): SessionPayload =>
  ({
    contract_version: "1.0",
    study: {
      id: "study-1",
      title: "Design system survey",
      intro_text: "Intro",
      consent_text: "Consent"
    },
    participant: { participant_id: "part-1" },
    session: {
      session_id: "sess-1",
      session_token: "tok-1",
      study_id: "study-1",
      participant_id: "part-1"
    },
    steps: steps.map((step, index) => ({
      step_id: `s${index + 1}`,
      order: index + 1,
      prompt: "Question",
      ...step
    }))
  }) as SessionPayload;

beforeEach(() => {
  saveParticipantResponse.mockReset().mockResolvedValue(undefined);
  sendRuntimeEvent.mockReset().mockResolvedValue(undefined);
});

/**
 * Renders past the consent gate, which every test below this point assumes has
 * already been cleared. The gate itself is exercised in its own describe.
 */
const renderRunner = async (payload: SessionPayload) => {
  const user = userEvent.setup();
  render(<SurveyRunner payload={payload} />);
  await user.click(screen.getByRole("button", { name: "Agree and start" }));
  sendRuntimeEvent.mockClear();
  return user;
};

describe("rendering each question type", () => {
  it("gives a choice group the prompt as its accessible name", async () => {
    await renderRunner(payloadWith([
          {
            type: "single_choice",
            prompt: "Which do you use most?",
            options: ["Jira", "Confluence"]
          }
        ]));

    // By role, not by text: a legend that is present but not associated with
    // the group still renders its words on the page, so a text query passes
    // while the group stays anonymous to a screen reader.
    expect(
      screen.getByRole("group", { name: "Which do you use most?" })
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Jira" })).toBeInTheDocument();
  });

  it("renders multi_choice as checkboxes, not radios", async () => {
    await renderRunner(payloadWith([
          {
            type: "multi_choice",
            prompt: "Which do you use?",
            options: ["Jira", "Confluence"]
          }
        ]));

    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("renders a rating from 1 to its scale", async () => {
    await renderRunner(
      payloadWith([
        { type: "rating", prompt: "How easy?", config: { scale_max: 5 } }
      ])
    );

    expect(screen.getAllByRole("radio")).toHaveLength(5);
    expect(screen.getByRole("radio", { name: "1" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "5" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "0" })).not.toBeInTheDocument();
  });

  // NPS is 0 to 10, eleven points, and the zero must be selectable - it is a
  // real score, not an absence of one.
  it("renders nps from 0 to 10", async () => {
    await renderRunner(payloadWith([{ type: "nps", prompt: "Recommend us?" }]));

    expect(screen.getAllByRole("radio")).toHaveLength(11);
    expect(screen.getByRole("radio", { name: "0" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "10" })).toBeInTheDocument();
  });

  it("labels the open text box with the prompt", async () => {
    await renderRunner(payloadWith([
          { type: "open_text", prompt: "What did you think?" }
        ]));

    expect(
      screen.getByRole("textbox", { name: "What did you think?" })
    ).toBeInTheDocument();
  });

  // The poles must stay readable. aria-hidden on them, or an aria-label on the
  // radios, leaves a screen reader user choosing between bare numbers with
  // nothing to say which end is good.
  it("spells out what the ends of a rating scale mean", async () => {
    await renderRunner(
      payloadWith([
        {
          type: "rating",
          prompt: "How easy?",
          config: { scale_max: 5, min_label: "Very hard", max_label: "Very easy" }
        }
      ])
    );

    expect(screen.getByText("1 = Very hard")).toBeInTheDocument();
    expect(screen.getByText("5 = Very easy")).toBeInTheDocument();
    // The number is still the radio's accessible name, not replaced by the pole.
    expect(screen.getByRole("radio", { name: "1" })).toBeInTheDocument();
  });
});

describe("answering and advancing", () => {
  const twoQuestions = payloadWith([
    { type: "open_text", prompt: "First question", is_required: true },
    { type: "open_text", prompt: "Second question" }
  ]);

  it("blocks advancing past a required question with no answer", async () => {
    const user = await renderRunner(twoQuestions);

    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByRole("alert")).toHaveTextContent(/answer this question/i);
    expect(saveParticipantResponse).not.toHaveBeenCalled();
    expect(
      screen.getByRole("textbox", { name: "First question" })
    ).toBeInTheDocument();
  });

  it("saves the answer and moves on", async () => {
    const user = await renderRunner(twoQuestions);

    await user.type(
      screen.getByRole("textbox", { name: "First question" }),
      "It was fine"
    );
    await user.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => {
      expect(
        screen.getByRole("textbox", { name: "Second question" })
      ).toBeInTheDocument();
    });

    expect(saveParticipantResponse).toHaveBeenCalledWith("tok-1", {
      stepId: "s1",
      stepType: "open_text",
      responsePayload: { text: "It was fine" }
    });
  });

  // A skipped optional question must not write a row: an empty payload in the
  // tally makes "did not answer" indistinguishable from "answered nothing".
  it("writes no response row for a skipped optional question", async () => {
    const user = await renderRunner(payloadWith([
          { type: "open_text", prompt: "Optional one", is_required: false },
          { type: "open_text", prompt: "Second question" }
        ]));

    await user.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => {
      expect(
        screen.getByRole("textbox", { name: "Second question" })
      ).toBeInTheDocument();
    });

    expect(saveParticipantResponse).not.toHaveBeenCalled();
  });

  it("keeps the participant on the question when saving fails", async () => {
    const user = userEvent.setup();
    saveParticipantResponse.mockRejectedValue(new Error("offline"));
    await renderRunner(twoQuestions);

    const box = screen.getByRole("textbox", { name: "First question" });
    await user.type(box, "It was fine");
    await user.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => {
      expect(screen.getByText(/could not save your answer/i)).toBeInTheDocument();
    });

    // The answer is still on screen and still theirs to retry. Advancing here
    // would discard an answer that never reached the server.
    expect(
      screen.getByRole("textbox", { name: "First question" })
    ).toHaveValue("It was fine");
  });

  it("finishes on the last question and thanks the participant", async () => {
    const user = await renderRunner(payloadWith([{ type: "open_text", prompt: "Only question" }]));

    await user.type(
      screen.getByRole("textbox", { name: "Only question" }),
      "Done"
    );
    await user.click(screen.getByRole("button", { name: "Finish" }));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Thank you" })
      ).toBeInTheDocument();
    });

    expect(sendRuntimeEvent).toHaveBeenCalledWith("tok-1", {
      eventType: "session_completed"
    });
  });

  it("does not count the end marker as a question", async () => {
    await renderRunner(payloadWith([
          { type: "open_text", prompt: "Only question" },
          { type: "end", prompt: "Thanks" }
        ]));

    expect(screen.getByText(/Question 1 of 1/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Finish" })).toBeInTheDocument();
  });

  it("lets the participant go back and keeps the earlier answer", async () => {
    const user = await renderRunner(twoQuestions);

    await user.type(
      screen.getByRole("textbox", { name: "First question" }),
      "It was fine"
    );
    await user.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Back" })).toBeEnabled();
    });

    await user.click(screen.getByRole("button", { name: "Back" }));

    expect(
      screen.getByRole("textbox", { name: "First question" })
    ).toHaveValue("It was fine");
  });

  it("disables Back on the first question", async () => {
    await renderRunner(twoQuestions);

    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
  });
});

describe("multi choice answering", () => {
  it("accumulates and removes selections", async () => {
    const user = await renderRunner(payloadWith([
          {
            type: "multi_choice",
            prompt: "Which do you use?",
            options: ["Jira", "Confluence", "Bitbucket"]
          }
        ]));

    await user.click(screen.getByRole("checkbox", { name: "Jira" }));
    await user.click(screen.getByRole("checkbox", { name: "Bitbucket" }));
    await user.click(screen.getByRole("checkbox", { name: "Jira" }));
    await user.click(screen.getByRole("button", { name: "Finish" }));

    await waitFor(() => {
      expect(saveParticipantResponse).toHaveBeenCalledWith("tok-1", {
        stepId: "s1",
        stepType: "multi_choice",
        responsePayload: { selectedOptions: ["Bitbucket"] }
      });
    });
  });

  it("enforces the selection cap before saving", async () => {
    const user = await renderRunner(
      payloadWith([
        {
          type: "multi_choice",
          prompt: "Pick up to two",
          options: ["a", "b", "c"],
          config: { max_selections: 2 }
        }
      ])
    );

    await user.click(screen.getByRole("checkbox", { name: "a" }));
    await user.click(screen.getByRole("checkbox", { name: "b" }));
    await user.click(screen.getByRole("checkbox", { name: "c" }));
    await user.click(screen.getByRole("button", { name: "Finish" }));

    expect(screen.getByRole("alert")).toHaveTextContent(/at most 2/);
    expect(saveParticipantResponse).not.toHaveBeenCalled();
  });
});

describe("nps answering", () => {
  // Zero is a real detractor score. Anything treating the rating as falsy
  // reports this as unanswered and silently drops it.
  it("saves a score of zero", async () => {
    const user = await renderRunner(payloadWith([{ type: "nps", prompt: "Recommend us?" }]));

    await user.click(screen.getByRole("radio", { name: "0" }));
    await user.click(screen.getByRole("button", { name: "Finish" }));

    await waitFor(() => {
      expect(saveParticipantResponse).toHaveBeenCalledWith("tok-1", {
        stepId: "s1",
        stepType: "nps",
        responsePayload: { rating: 0 }
      });
    });
  });
});

/**
 * Consent gate.
 *
 * A survey exists to collect personal responses, so the participant has to be
 * told what happens to them and agree before a single question is shown. The
 * recorded flow already gates this way and emits the same two runtime events;
 * the survey has the same obligation with none of the recording apparatus.
 */
describe("consent", () => {
  const payload = payloadWith([
    { type: "open_text", prompt: "First question", is_required: true }
  ]);

  it("shows the study's own consent text before anything else", () => {
    render(<SurveyRunner payload={payload} />);

    expect(screen.getByText("Consent")).toBeInTheDocument();
  });

  // The gate is worthless if the questions are merely further down the page.
  it("shows no question until consent is given", () => {
    render(<SurveyRunner payload={payload} />);

    expect(
      screen.queryByRole("textbox", { name: "First question" })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
  });

  it("records the agreement and opens the first question", async () => {
    const user = userEvent.setup();
    render(<SurveyRunner payload={payload} />);

    await user.click(screen.getByRole("button", { name: "Agree and start" }));

    expect(
      screen.getByRole("textbox", { name: "First question" })
    ).toBeInTheDocument();
    expect(sendRuntimeEvent).toHaveBeenCalledWith("tok-1", {
      eventType: "consent_accepted"
    });
  });

  /**
   * The researcher's funnel reads `opportunity_session_events`, and
   * `resolveLifecycleEvent` writes a row only for session_started,
   * session_completed, session_abandoned and session_failed. Without a start
   * event a native survey showed completions with no starts - people finishing
   * something they never began.
   */
  it("tells the funnel the session started, not just that consent was given", async () => {
    const user = userEvent.setup();
    render(<SurveyRunner payload={payload} />);

    await user.click(screen.getByRole("button", { name: "Agree and start" }));

    await waitFor(() => {
      expect(sendRuntimeEvent).toHaveBeenCalledWith("tok-1", {
        eventType: "session_started",
        metadata: { source: "survey_runner" }
      });
    });
  });

  it("does not claim a session started when consent was refused", async () => {
    const user = userEvent.setup();
    render(<SurveyRunner payload={payload} />);

    await user.click(screen.getByRole("button", { name: "Do not agree" }));

    await waitFor(() => {
      expect(sendRuntimeEvent).toHaveBeenCalledWith("tok-1", {
        eventType: "consent_declined"
      });
    });
    // A refusal is a session_abandoned in the funnel. A start beside it would
    // count someone who saw the consent text and left as a participant.
    expect(sendRuntimeEvent).not.toHaveBeenCalledWith(
      "tok-1",
      expect.objectContaining({ eventType: "session_started" })
    );
  });

  it("still starts the session when the consent event fails to send", async () => {
    const user = userEvent.setup();
    // Only the first call fails. Chained in one try, this would have taken the
    // start with it and lost the funnel entry for someone now answering.
    sendRuntimeEvent.mockRejectedValueOnce(new Error("network"));
    render(<SurveyRunner payload={payload} />);

    await user.click(screen.getByRole("button", { name: "Agree and start" }));

    await waitFor(() => {
      expect(sendRuntimeEvent).toHaveBeenCalledWith("tok-1", {
        eventType: "session_started",
        metadata: { source: "survey_runner" }
      });
    });
    expect(
      screen.getByRole("textbox", { name: "First question" })
    ).toBeInTheDocument();
  });

  it("keeps the participant moving when the start event fails to send", async () => {
    const user = userEvent.setup();
    sendRuntimeEvent
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("network"));
    render(<SurveyRunner payload={payload} />);

    await user.click(screen.getByRole("button", { name: "Agree and start" }));

    // Telemetry is not a gate. Someone who has just agreed must not be held on
    // the consent screen because an analytics write failed.
    expect(
      screen.getByRole("textbox", { name: "First question" })
    ).toBeInTheDocument();
  });

  it("records a decline and ends the session there", async () => {
    const user = userEvent.setup();
    render(<SurveyRunner payload={payload} />);

    await user.click(screen.getByRole("button", { name: "Do not agree" }));

    await waitFor(() => {
      expect(sendRuntimeEvent).toHaveBeenCalledWith("tok-1", {
        eventType: "consent_declined"
      });
    });

    expect(
      screen.queryByRole("textbox", { name: "First question" })
    ).not.toBeInTheDocument();
    expect(saveParticipantResponse).not.toHaveBeenCalled();
  });

  // Declining is terminal. Offering a way back turns a refusal into a prompt
  // to reconsider, which is not consent freely given.
  // Asserts the terminal screen is actually REACHED, not merely that the
  // consent button has gone. Without the positive assertion this passed when
  // the declined branch was deleted entirely and the runner fell through to
  // the questions, because the consent button is absent there too.
  it("lands on a terminal screen with no way back in", async () => {
    const user = userEvent.setup();
    render(<SurveyRunner payload={payload} />);

    await user.click(screen.getByRole("button", { name: "Do not agree" }));

    expect(screen.getByRole("heading", { name: "No problem" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Agree and start" })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
  });
});
