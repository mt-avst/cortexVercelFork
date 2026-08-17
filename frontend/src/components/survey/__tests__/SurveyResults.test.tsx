import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

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
