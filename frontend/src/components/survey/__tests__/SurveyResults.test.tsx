import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SurveyResults, type SurveyResultsData } from "../SurveyResults";

const data = (
  questions: SurveyResultsData["questions"],
  respondents = 3
): SurveyResultsData => ({ respondents, questions });

describe("choice results", () => {
  const results = data([
    {
      step_id: "q1",
      prompt: "Which do you use?",
      type: "single_choice",
      answered: 3,
      options: [
        { option: "Jira", count: 2, percent: 66.7 },
        { option: "Confluence", count: 1, percent: 33.3 },
        { option: "Bitbucket", count: 0, percent: 0 }
      ]
    }
  ]);

  // The count and the share must be readable as text. A bar alone is invisible
  // to a screen reader and unreadable in monochrome.
  it("renders every option with its count and share as text", () => {
    render(<SurveyResults results={results} title="Survey" />);

    const row = screen.getByRole("row", { name: /Jira/ });
    expect(within(row).getByText("2")).toBeInTheDocument();
    expect(within(row).getByText("66.7%")).toBeInTheDocument();
  });

  it("still shows an option nobody chose", () => {
    render(<SurveyResults results={results} title="Survey" />);

    const row = screen.getByRole("row", { name: /Bitbucket/ });
    expect(within(row).getByText("0%")).toBeInTheDocument();
  });

  it("names the retired options rather than hiding them", () => {
    render(
      <SurveyResults
        results={data([
          {
            ...results.questions[0],
            retired_options: [{ option: "Crucible", count: 2 }]
          }
        ])}
        title="Survey"
      />
    );

    expect(screen.getByText(/Crucible \(2\)/)).toBeInTheDocument();
  });

  // Shares over 100 look like a bug unless the reason is stated.
  it("explains why multi choice shares exceed 100%", () => {
    render(
      <SurveyResults
        results={data([{ ...results.questions[0], type: "multi_choice" }])}
        title="Survey"
      />
    );

    expect(screen.getByText(/more than one/i)).toBeInTheDocument();
  });

  it("does not show the multi choice note on a single choice question", () => {
    render(<SurveyResults results={results} title="Survey" />);

    expect(screen.queryByText(/more than one/i)).not.toBeInTheDocument();
  });
});

describe("rating results", () => {
  it("shows the average", () => {
    render(
      <SurveyResults
        results={data([
          {
            step_id: "q1",
            prompt: "How easy?",
            type: "rating",
            answered: 3,
            mean: 4.7,
            distribution: [
              { value: 1, count: 0 },
              { value: 2, count: 0 },
              { value: 3, count: 0 },
              { value: 4, count: 1 },
              { value: 5, count: 2 }
            ]
          }
        ])}
        title="Survey"
      />
    );

    expect(screen.getByText("Average 4.7")).toBeInTheDocument();
  });

  // A null mean must not render as "Average 0" - zero is not on the scale.
  it("says there is no average rather than showing zero", () => {
    render(
      <SurveyResults
        results={data([
          {
            step_id: "q1",
            prompt: "How easy?",
            type: "rating",
            answered: 0,
            mean: null,
            distribution: [{ value: 1, count: 0 }]
          }
        ])}
        title="Survey"
      />
    );

    expect(screen.getByText("No average yet")).toBeInTheDocument();
    expect(screen.queryByText(/Average 0/)).not.toBeInTheDocument();
  });
});

describe("nps results", () => {
  it("shows the score and the three bands", () => {
    render(
      <SurveyResults
        results={data([
          {
            step_id: "q1",
            prompt: "Recommend?",
            type: "nps",
            answered: 10,
            score: 30,
            promoters: 5,
            passives: 3,
            detractors: 2,
            distribution: [{ value: 0, count: 1 }]
          }
        ])}
        title="Survey"
      />
    );

    expect(screen.getByText("NPS 30")).toBeInTheDocument();
    expect(screen.getByText(/5 promoters, 3 passives, 2 detractors/)).toBeInTheDocument();
  });

  // A negative NPS is a real and important result. It must not be swallowed.
  it("shows a negative score", () => {
    render(
      <SurveyResults
        results={data([
          {
            step_id: "q1",
            prompt: "Recommend?",
            type: "nps",
            answered: 4,
            score: -50,
            promoters: 1,
            passives: 0,
            detractors: 3,
            distribution: [{ value: 0, count: 3 }]
          }
        ])}
        title="Survey"
      />
    );

    expect(screen.getByText("NPS -50")).toBeInTheDocument();
  });
});

describe("open text results", () => {
  it("lists every answer", () => {
    render(
      <SurveyResults
        results={data([
          {
            step_id: "q1",
            prompt: "What would you change?",
            type: "open_text",
            answered: 2,
            answers: [
              { session_id: "s1", text: "Better search" },
              { session_id: "s2", text: "More examples" }
            ]
          }
        ])}
        title="Survey"
      />
    );

    expect(screen.getByText("Better search")).toBeInTheDocument();
    expect(screen.getByText("More examples")).toBeInTheDocument();
  });
});

describe("the page as a whole", () => {
  it("counts participants and offers the CSV", () => {
    render(
      <SurveyResults
        csvHref="/api/firsthand/studies/abc/results.csv"
        results={data([], 7)}
        title="Design system survey"
      />
    );

    expect(screen.getByRole("heading", { name: "Design system survey" })).toBeInTheDocument();
    expect(screen.getByText("7 participants")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download CSV" })).toHaveAttribute(
      "href",
      "/api/firsthand/studies/abc/results.csv"
    );
  });

  it("says participant, singular, when there is one", () => {
    render(<SurveyResults results={data([], 1)} title="Survey" />);

    expect(screen.getByText("1 participant")).toBeInTheDocument();
  });

  it("offers no CSV link when there is no href", () => {
    render(<SurveyResults results={data([], 0)} title="Survey" />);

    expect(screen.queryByRole("link", { name: "Download CSV" })).not.toBeInTheDocument();
  });

  it("says so when a question has no answers", () => {
    render(
      <SurveyResults
        results={data([
          {
            step_id: "q1",
            prompt: "Which?",
            type: "single_choice",
            answered: 0,
            options: [{ option: "a", count: 0, percent: 0 }]
          }
        ])}
        title="Survey"
      />
    );

    expect(screen.getByText("No answers yet.")).toBeInTheDocument();
  });
});

/**
 * F2. Answers to questions the study no longer has.
 *
 * Removing a question DETACHES its answers rather than deleting them. This
 * section is where a researcher finds them, and the reason it is a section
 * rather than another card in the list: nobody is being asked these any more,
 * and a reader scanning denominators down one list would have no way to tell.
 */
describe("removed questions", () => {
  const withRemoved = (): SurveyResultsData => ({
    respondents: 2,
    questions: [
      {
        step_id: "q1",
        prompt: "Still asked",
        type: "open_text",
        answered: 1,
        answers: [{ session_id: "s1", text: "a live answer" }]
      }
    ],
    removed_questions: [
      {
        step_id: "",
        prompt: "What did you think of the old checkout?",
        type: "open_text",
        answered: 1,
        answers: [{ session_id: "s2", text: "a detached answer" }]
      }
    ]
  });

  it("shows the answers under their own heading, with the prompt as it was", () => {
    render(<SurveyResults results={withRemoved()} title="Survey" />);

    const section = screen
      .getByRole("heading", { name: "Removed questions" })
      .closest("section") as HTMLElement;

    expect(
      within(section).getByRole("heading", {
        name: "What did you think of the old checkout?"
      })
    ).toBeInTheDocument();
    expect(within(section).getByText("a detached answer")).toBeInTheDocument();
    // And the live answer is NOT in there. Scoping the first assertion without
    // this one would pass against a component that rendered every question
    // twice.
    expect(within(section).queryByText("a live answer")).not.toBeInTheDocument();
  });

  it("gives each removed question a key of its own", () => {
    // `step_id` is the empty string on ALL of these - there is no id once the
    // question is deleted - so keying the list on it hands React the same key
    // twice. An independent mutation pass proved that is invisible here
    // otherwise: React still renders both children, so the "renders every
    // removed question" assertion below passes, and the only signal is a
    // warning on stderr that vitest does not fail on. Reconciliation with
    // duplicate keys is undefined enough that a list which grows or reorders
    // later would reuse the wrong node.
    const errors: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args);
    });

    const results = withRemoved();
    results.removed_questions = [
      ...(results.removed_questions ?? []),
      {
        step_id: "",
        prompt: "Which docs did you read?",
        type: "open_text",
        answered: 1,
        answers: [{ session_id: "s2", text: "the API reference" }]
      }
    ];

    render(<SurveyResults results={results} title="Survey" />);
    spy.mockRestore();

    expect(
      errors.filter((args) => String(args[0]).includes("same key"))
    ).toEqual([]);
  });

  it("renders every removed question, not just the first", () => {
    // `step_id` is the empty string on all of them - there is no id once the
    // question is deleted - so keying the list on it would collapse them to one.
    const results = withRemoved();
    results.removed_questions = [
      ...(results.removed_questions ?? []),
      {
        step_id: "",
        prompt: "Which docs did you read?",
        type: "open_text",
        answered: 1,
        answers: [{ session_id: "s2", text: "the API reference" }]
      }
    ];

    render(<SurveyResults results={results} title="Survey" />);

    expect(
      screen.getByRole("heading", { name: "What did you think of the old checkout?" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Which docs did you read?" })
    ).toBeInTheDocument();
  });

  it("puts a removed question BELOW the section heading in the outline", () => {
    // The section heading explains what these are, so a question inside it is
    // subordinate to that explanation. Rendering both at h3 would tell a screen
    // reader they are siblings.
    render(<SurveyResults results={withRemoved()} title="Survey" />);

    expect(
      screen.getByRole("heading", { name: "Removed questions", level: 3 })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: "What did you think of the old checkout?",
        level: 4
      })
    ).toBeInTheDocument();
    // The live question stays at h3, directly under the results heading.
    expect(
      screen.getByRole("heading", { name: "Still asked", level: 3 })
    ).toBeInTheDocument();
  });

  it("renders no section at all when nothing was removed", () => {
    render(
      <SurveyResults
        results={{ respondents: 1, questions: [], removed_questions: [] }}
        title="Survey"
      />
    );

    expect(
      screen.queryByRole("heading", { name: "Removed questions" })
    ).not.toBeInTheDocument();
  });
});

/**
 * F2. A question reworded after people answered it.
 *
 * The card labels every answer with the question's CURRENT wording, so a
 * researcher reading it has to be told when some of those answers were given
 * against something else. Without this the reword is invisible, and the
 * migration that records the wording would be storing a column nobody reads.
 */
describe("earlier wordings", () => {
  const reworded = (): SurveyResultsData => ({
    respondents: 3,
    questions: [
      {
        step_id: "q1",
        prompt: "How was support?",
        type: "open_text",
        answered: 3,
        answers: [{ session_id: "s1", text: "slow" }],
        asked_as: [{ prompt: "How was checkout?", answered: 2 }]
      }
    ]
  });

  it("says which wording those answers were given against, and how many", () => {
    render(<SurveyResults results={reworded()} title="Survey" />);

    expect(
      screen.getByText(/Some of these answers were given against different wording/)
    ).toHaveTextContent('"How was checkout?" (2)');
  });

  it("says nothing when every answer was given against the current wording", () => {
    const results = reworded();
    delete results.questions[0].asked_as;

    render(<SurveyResults results={results} title="Survey" />);

    expect(
      screen.queryByText(/given against different wording/)
    ).not.toBeInTheDocument();
  });
});
