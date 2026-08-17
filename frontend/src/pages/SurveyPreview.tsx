import { useState } from "react";

import type { SessionPayload } from "../shared/firsthand/contract";
import {
  SurveyRunner,
  type SurveyTransport
} from "../components/survey/SurveyRunner";
import {
  SurveyResults,
  type SurveyResultsData
} from "../components/survey/SurveyResults";

/**
 * A local harness for looking at the native survey runner before it is wired
 * to a real opportunity.
 *
 * Mounted only when the app is built with VITE_SURVEY_PREVIEW=1, so it is not
 * a route in any real build. It exists because the wiring that will reach this
 * runner for real - the authoring toggle, the publish guard, the detail page
 * routing - lives in files being rewritten on other branches, and none of that
 * can land until those merge. Without this there is no way to see it at all.
 *
 * Not gated on import.meta.env.DEV because the dev server does not boot this
 * app: shared/config/environment.ts reads a bare `process.env`, so every dev
 * page dies before React mounts. See the route in App.tsx.
 *
 * Delete this page once the real route exists.
 */

const DEMO_PAYLOAD: SessionPayload = {
  contract_version: "1.0",
  study: {
    id: "demo-survey",
    title: "Design system survey",
    intro_text: "A few questions about how you use the design system.",
    consent_text: "Your answers are stored for research analysis."
  },
  participant: { participant_id: "demo-participant" },
  session: {
    session_id: "demo-session",
    session_token: "demo-token",
    study_id: "demo-survey",
    participant_id: "demo-participant"
  },
  steps: [
    {
      step_id: "demo_1",
      order: 1,
      type: "single_choice",
      prompt: "Which product do you work in most?",
      is_required: true,
      options: ["Jira", "Confluence", "Bitbucket", "Something else"]
    },
    {
      step_id: "demo_2",
      order: 2,
      type: "multi_choice",
      prompt: "Which parts of the design system have you used?",
      helper_text: "Choose up to three.",
      config: { max_selections: 3 },
      options: ["Design tokens", "Components", "Icons", "Patterns", "Guidelines"]
    },
    {
      step_id: "demo_3",
      order: 3,
      type: "rating",
      prompt: "How easy was it to find what you needed?",
      is_required: true,
      config: { scale_max: 5, min_label: "Very hard", max_label: "Very easy" }
    },
    {
      step_id: "demo_4",
      order: 4,
      type: "nps",
      prompt: "How likely are you to recommend the design system to a colleague?",
      is_required: true
    },
    {
      step_id: "demo_5",
      order: 5,
      type: "open_text",
      prompt: "What is the one thing you would change?",
      helper_text: "Optional, but the most useful answer in the set."
    },
    {
      step_id: "demo_end",
      order: 6,
      type: "end",
      prompt: "Thanks - that is the end of the survey."
    }
  ]
};

/**
 * Answers go nowhere. There is no demo session on the runtime, so the real
 * client would 404 on every save and the runner would correctly refuse to
 * advance - leaving the preview stuck on question one.
 */
const PREVIEW_TRANSPORT: SurveyTransport = {
  saveAnswer: async (_token, input) => {
    console.info("[survey preview] answer", input.stepId, input.responsePayload);
  },
  recordEvent: async (_token, input) => {
    console.info("[survey preview] event", input.eventType);
  }
};

/**
 * Plausible numbers rather than round ones, so the layout is exercised the way
 * real data exercises it: a share that needs a decimal place, an option nobody
 * chose, an option the author has since deleted, and a negative NPS.
 */
const DEMO_RESULTS: SurveyResultsData = {
  respondents: 24,
  questions: [
    {
      step_id: "demo_1",
      prompt: "Which product do you work in most?",
      type: "single_choice",
      answered: 24,
      options: [
        { option: "Jira", count: 11, percent: 45.8 },
        { option: "Confluence", count: 8, percent: 33.3 },
        { option: "Bitbucket", count: 5, percent: 20.8 },
        { option: "Something else", count: 0, percent: 0 }
      ],
      retired_options: [{ option: "Crucible", count: 2 }]
    },
    {
      step_id: "demo_2",
      prompt: "Which parts of the design system have you used?",
      type: "multi_choice",
      answered: 21,
      options: [
        { option: "Components", count: 19, percent: 90.5 },
        { option: "Design tokens", count: 12, percent: 57.1 },
        { option: "Icons", count: 9, percent: 42.9 },
        { option: "Patterns", count: 4, percent: 19 },
        { option: "Guidelines", count: 2, percent: 9.5 }
      ]
    },
    {
      step_id: "demo_3",
      prompt: "How easy was it to find what you needed?",
      type: "rating",
      answered: 24,
      mean: 3.2,
      distribution: [
        { value: 1, count: 2 },
        { value: 2, count: 5 },
        { value: 3, count: 8 },
        { value: 4, count: 6 },
        { value: 5, count: 3 }
      ]
    },
    {
      step_id: "demo_4",
      prompt: "How likely are you to recommend the design system?",
      type: "nps",
      answered: 24,
      score: -8,
      promoters: 6,
      passives: 10,
      detractors: 8,
      distribution: [
        { value: 0, count: 1 },
        { value: 1, count: 0 },
        { value: 2, count: 1 },
        { value: 3, count: 1 },
        { value: 4, count: 2 },
        { value: 5, count: 2 },
        { value: 6, count: 1 },
        { value: 7, count: 4 },
        { value: 8, count: 6 },
        { value: 9, count: 4 },
        { value: 10, count: 2 }
      ]
    },
    {
      step_id: "demo_5",
      prompt: "What is the one thing you would change?",
      type: "open_text",
      answered: 3,
      answers: [
        { session_id: "s1", text: "Search never finds the component I want by its real name." },
        { session_id: "s2", text: "More worked examples, fewer prop tables." },
        { session_id: "s3", text: "Tokens and components disagree about spacing." }
      ]
    }
  ]
};

export default function SurveyPreview() {
  const [key, setKey] = useState(0);

  return (
    <div>
      {/* Its own class, not the runner's .survey-progress: sharing it made a
          querySelector for the progress line match this banner instead. */}
      <p className="survey-preview-banner">
        Development preview. Answers are not saved.{" "}
        <button
          className="button button-secondary"
          onClick={() => {
            setKey((current) => current + 1);
          }}
          type="button"
        >
          Start again
        </button>
      </p>

      <SurveyRunner key={key} payload={DEMO_PAYLOAD} transport={PREVIEW_TRANSPORT} />

      <hr className="survey-preview-rule" />

      <div className="survey-preview-results">
        <SurveyResults
          csvHref="#"
          results={DEMO_RESULTS}
          title="Design system survey"
        />
      </div>
    </div>
  );
}
