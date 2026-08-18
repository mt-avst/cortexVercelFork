import "./survey-results.css";

/**
 * The results of a natively-run poll or survey.
 *
 * Tallies are tables with a bar drawn inside the row, not charts. A table is
 * navigable by a screen reader, sorts and copies into a spreadsheet, and keeps
 * the count and the percentage as text - so nothing here is encoded in colour
 * or length alone. The bar is decoration over numbers that are already legible.
 */

export type OptionTally = { option: string; count: number; percent: number };

export type QuestionResult = {
  step_id: string;
  prompt: string;
  type: string;
  answered: number;
  options?: OptionTally[];
  retired_options?: { option: string; count: number }[];
  distribution?: { value: number; count: number }[];
  mean?: number | null;
  promoters?: number;
  passives?: number;
  detractors?: number;
  score?: number | null;
  answers?: { session_id: string; text: string }[];
};

export type SurveyResultsData = {
  respondents: number;
  questions: QuestionResult[];
};

function Bar({ percent }: { percent: number }) {
  return (
    <span aria-hidden="true" className="result-bar">
      <span className="result-bar-fill" style={{ width: `${percent}%` }} />
    </span>
  );
}

function TallyTable({
  caption,
  rows,
  total
}: {
  caption: string;
  rows: { label: string; count: number; percent: number }[];
  total: number;
}) {
  return (
    <table className="result-table">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Answer</th>
          <th scope="col">Count</th>
          <th scope="col">Share</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label}>
            <th scope="row">{row.label}</th>
            <td>{row.count}</td>
            <td>
              {/* Both numbers stay as text. The bar is added beside them, not
                  instead of them. */}
              <span className="result-share">{row.percent}%</span>
              <Bar percent={row.percent} />
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row">Answered</th>
          <td colSpan={2}>{total}</td>
        </tr>
      </tfoot>
    </table>
  );
}

function QuestionCard({ question }: { question: QuestionResult }) {
  const { type } = question;

  return (
    <section className="result-question">
      <h3>{question.prompt}</h3>

      {question.answered === 0 ? (
        <p className="result-empty">No answers yet.</p>
      ) : null}

      {(type === "single_choice" || type === "multi_choice") &&
      question.options ? (
        <>
          {type === "multi_choice" ? (
            // Said plainly, because shares that total more than 100 look like
            // an error otherwise.
            <p className="result-note">
              People could choose more than one, so shares add up to more than
              100%.
            </p>
          ) : null}

          <TallyTable
            caption={question.prompt}
            rows={question.options.map((option) => ({
              label: option.option,
              count: option.count,
              percent: option.percent
            }))}
            total={question.answered}
          />

          {question.retired_options?.length ? (
            <p className="result-note">
              Answers to options since removed from this question:{" "}
              {question.retired_options
                .map((option) => `${option.option} (${option.count})`)
                .join(", ")}
            </p>
          ) : null}
        </>
      ) : null}

      {type === "rating" && question.distribution ? (
        <>
          <p className="result-headline">
            {question.mean === null || question.mean === undefined
              ? "No average yet"
              : `Average ${question.mean}`}
          </p>
          <TallyTable
            caption={question.prompt}
            rows={question.distribution.map((point) => ({
              label: String(point.value),
              count: point.count,
              percent:
                question.answered === 0
                  ? 0
                  : Math.round((point.count / question.answered) * 1000) / 10
            }))}
            total={question.answered}
          />
        </>
      ) : null}

      {type === "nps" && question.distribution ? (
        <>
          <p className="result-headline">
            {question.score === null || question.score === undefined
              ? "No score yet"
              : `NPS ${question.score}`}
          </p>
          <p className="result-note">
            {question.promoters ?? 0} promoters, {question.passives ?? 0}{" "}
            passives, {question.detractors ?? 0} detractors
          </p>
          <TallyTable
            caption={question.prompt}
            rows={question.distribution.map((point) => ({
              label: String(point.value),
              count: point.count,
              percent:
                question.answered === 0
                  ? 0
                  : Math.round((point.count / question.answered) * 1000) / 10
            }))}
            total={question.answered}
          />
        </>
      ) : null}

      {type === "open_text" && question.answers?.length ? (
        <ul className="result-answers">
          {question.answers.map((answer, index) => (
            <li key={`${answer.session_id}-${index}`}>{answer.text}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function SurveyResults({
  csvHref,
  results,
  title
}: {
  csvHref?: string;
  results: SurveyResultsData;
  /**
   * Optional, and usually omitted. The surface embedding this already names
   * what is being looked at - the analytics page header says which opportunity
   * - so passing the STUDY's title here rendered the same words twice when they
   * matched, which is every real case today, and two different names for one
   * screen when they did not (a study reused by an opportunity its author did
   * not create).
   *
   * The heading itself stays rather than being dropped: the page is h1, the
   * questions are h3, and removing this would skip a level.
   */
  title?: string;
}) {
  return (
    <div className="survey-results">
      <header className="survey-results-header">
        <h2>{title ?? "Responses"}</h2>
        <p className="result-note">
          {results.respondents}{" "}
          {results.respondents === 1 ? "participant" : "participants"}
        </p>
        {csvHref ? (
          <a className="button button-secondary" href={csvHref}>
            Download CSV
          </a>
        ) : null}
      </header>

      {results.questions.length === 0 ? (
        <p className="result-empty">This study has no questions.</p>
      ) : (
        results.questions.map((question) => (
          <QuestionCard key={question.step_id} question={question} />
        ))
      )}
    </div>
  );
}
