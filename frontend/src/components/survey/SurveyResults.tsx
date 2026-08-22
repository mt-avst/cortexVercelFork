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
  /**
   * Wordings this question was asked in that are not its current wording,
   * recorded beside each answer at the moment it was given.
   *
   * Rendered because an author may now fix a typo on a live survey, and a
   * researcher reading the results has to be able to see that some of the
   * answers underneath were given against something else.
   */
  asked_as?: { prompt: string; answered: number }[];
};

export type SurveyResultsData = {
  respondents: number;
  questions: QuestionResult[];
  /**
   * Answers to questions this study no longer has, because the author removed
   * them after these participants had already answered.
   *
   * Their own section, under their own heading, rather than mixed in with the
   * live questions - the numbers are real but nobody is being asked them any
   * more, and a reader scanning denominators down one list would have no way to
   * tell. Optional because it is omitted rather than sent empty.
   */
  removed_questions?: QuestionResult[];
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

/**
 * @param headingLevel
 *   Which heading element the prompt renders as. The page is h1 and this
 *   component's own container is h2, so a question is h3 by default - but the
 *   removed-questions section adds an h3 of its own, and the questions inside
 *   it are subordinate to that heading rather than siblings of it. Hardcoding
 *   h3 in both places would tell a screen-reader user that a removed question
 *   sits at the same level as the section explaining what removed questions
 *   are.
 */
function QuestionCard({
  question,
  headingLevel = 'h3'
}: {
  question: QuestionResult;
  headingLevel?: 'h3' | 'h4';
}) {
  const { type } = question;
  const Heading = headingLevel;

  return (
    <section className="result-question">
      <Heading>{question.prompt}</Heading>

      {question.answered === 0 ? (
        <p className="result-empty">No answers yet.</p>
      ) : null}

      {question.asked_as?.length ? (
        <p className="result-note">
          Some of these answers were given against different wording:{' '}
          {question.asked_as
            .map((wording) => `"${wording.prompt}" (${wording.answered})`)
            .join(', ')}
        </p>
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
        {/*
          A NEW TAB, because this href can now answer 503.

          The export route is gated on a concurrency permit, and a refusal is a
          JSON body. Followed in the current tab, that REPLACES the page the
          researcher is reading with `{"error":"Too many result sets..."}` and
          loses their state - and the gate makes that likelier, not less, since
          the aggregate view they are looking at holds no permit but the export
          needs one. A blank tab absorbs the error instead; on success the
          browser takes the attachment and the tab never appears.

          Not the whole fix. Fetching the CSV through the API client would let
          this surface the same worded message as the aggregate above, at the
          cost of holding the file in memory rather than streaming it to disk.
          That is a deliberate deferral, named in !203, not an oversight.
        */}
        {csvHref ? (
          <a
            className="button button-secondary"
            href={csvHref}
            rel="noopener"
            target="_blank"
          >
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

      {results.removed_questions?.length ? (
        <section className="survey-results-removed">
          <h3>Removed questions</h3>
          <p className="result-note">
            These questions are no longer part of the study. The answers below
            were given while they still were, and are shown under the wording
            each participant actually saw.
          </p>
          {results.removed_questions.map((question, index) => (
            // Indexed, deliberately: a removed question HAS no step id - it was
            // nulled when the question was deleted - so `step_id` is the empty
            // string on every one of these and would collapse the list to a
            // single key. The list is rendered from a value that never changes
            // between renders, so the index is stable identity here.
            <QuestionCard
              key={`removed-${index}`}
              question={question}
              headingLevel="h4"
            />
          ))}
        </section>
      ) : null}
    </div>
  );
}
