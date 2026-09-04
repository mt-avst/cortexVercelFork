import React from 'react';
import { Card, CardBody } from './ui/Card';
import { DoorCard, CLOSING_DOORS } from './DoorCard';

/**
 * SalesSections Component
 *
 * Below-the-fold landing content for Cortex. This is Dr Nick Fine's v11
 * narrative, laid into the live dark/glass design system: the loop, the two
 * audiences, the methods, the promises, the founder voice, and the closing
 * doors. The opening doors and the proposition sit in the hero (Landing.tsx),
 * inside the first viewport, so nothing a cold visitor needs is behind a scroll.
 *
 * All headings are h2 or below (h1 is in the hero). Each section carries a
 * data-section attribute, which is how SalesSections.test.tsx addresses it.
 * Nothing reads these for analytics, so do not say that they do.
 *
 * Every claim here is meant to be checkable against the product. The copy that
 * shipped before this went unedited from 7.1.2 to 7.55.x and drifted into
 * fabrications - invented usage metrics, unattributed testimonials, a
 * participant-matching engine that has never existed, a Jira/Confluence
 * integration. SalesSections.test.tsx pins those banned phrases by literal so
 * they cannot come back quietly. When editing this copy, keep it honest: the
 * mechanism is that anyone at Adaptavist can find a published study and book a
 * slot, not that Cortex actively matches people to requests.
 */

interface SalesSectionsProps {
  onAccessCortex: () => void;
  isLoading: boolean;
}

// ============================================================
// DATA - Keeps copy changes trivial and future-proof
// ============================================================

interface AudienceBeat {
  index: number;
  title: string;
  text: string;
}

interface Audience {
  who: string;
  lead: string;
  outcome: string;
  beats: ReadonlyArray<AudienceBeat>;
}

const AUDIENCES: ReadonlyArray<Audience> = [
  {
    who: 'The people building it',
    lead: 'You don’t need to be a researcher. You need a question.',
    outcome:
      'Fewer arguments, fewer rebuilds and a feature you can defend with what people actually said. The question that would have taken a month to ask takes a week.',
    beats: [
      {
        index: 1,
        title: 'Ask it',
        text: 'Write the question, pick a format. Interview, test, poll, survey or a recorded task. The form checks each step as you go.',
      },
      {
        index: 2,
        title: 'The right people turn up',
        text: 'Anyone at Adaptavist can find your study and book a slot. No chasing, no spreadsheet of names, no favours.',
      },
      {
        index: 3,
        title: 'Decide on evidence',
        text: 'Recordings, transcripts, answers and analytics on one page. Take it into the room instead of an opinion.',
      },
    ],
  },
  {
    who: 'The people who’ll tell the truth about it',
    lead: 'Fifteen minutes, your own browser, no prep.',
    outcome:
      'The tools you use next year shaped by what you said this year, and your contribution on the record, not your answers, rather than lost in a Slack thread.',
    beats: [
      {
        index: 1,
        title: 'Get asked',
        text: 'Someone building something wants to know what you think, about a thing you use or a thing you’ve never seen. Book a slot that suits you.',
      },
      {
        index: 2,
        title: 'Say it straight',
        text: 'Say what you’d say to a colleague you trust, not what you’d say in a review. Your manager doesn’t see it. Stop whenever you like.',
      },
      {
        index: 3,
        title: 'See what changed',
        text: 'You get the results and the owner tells you what they did with them. If the answer was nothing, they tell you that too.',
      },
    ],
  },
];

interface Method {
  method: string;
  what: string;
  when: string;
  get: string;
  gives: string;
  highlight: boolean;
}

// Participant durations are placeholders until real studies have run.
const METHODS: ReadonlyArray<Method> = [
  {
    method: 'Interview',
    what: 'A booked conversation, recorded and transcribed',
    when: 'You don’t know what the problem is yet',
    get: 'Recording, transcript, the language people use',
    gives: '30–45 min, booked',
    highlight: false,
  },
  {
    method: 'Usability test',
    what: 'A participant works through real tasks while you observe',
    when: 'You suspect something is confusing',
    get: 'Observed behaviour, where people stall, recording',
    gives: '30 min, booked',
    highlight: false,
  },
  {
    method: 'Recorded study',
    what: 'Participants do the tasks alone in their browser, screen and voice captured',
    when: 'Same as a test but you can’t be in the room',
    get: 'Screen and voice playback, transcript, no diary juggling',
    gives: '15 min, any time',
    highlight: true,
  },
  {
    method: 'Poll',
    what: 'One question, quick answer, inside Cortex',
    when: 'You need one answer from many people fast',
    get: 'A count you can quote in the meeting',
    gives: '1 min, any time',
    highlight: false,
  },
  {
    method: 'Survey',
    what: 'Several questions, native or via the survey tool the team already licences',
    when: 'You need several answers from many people',
    get: 'Structured responses, CSV export',
    gives: '5–10 min, any time',
    highlight: false,
  },
];

interface Promise {
  to: string;
  title: string;
  text: string;
}

const PROMISES: ReadonlyArray<Promise> = [
  {
    to: 'to participants',
    title: 'Your answers go to the study owner only',
    text: 'Not your manager, not every admin. Recordings and transcripts are owner-gated.',
  },
  {
    to: 'to participants',
    title: 'You hear what happened',
    text: 'Results are shared back to everyone who took part. That is the owner’s job and the one rule of running a study.',
  },
  {
    to: 'to participants',
    title: 'You can stop mid-way',
    text: 'No reason needed, and what you agreed to stays on record.',
  },
  {
    to: 'to study owners',
    title: 'Recruitment is done for you',
    text: 'Publish once. Booking, time zones and calendar clashes are handled.',
  },
  {
    to: 'to study owners',
    title: 'The method is built in',
    text: 'Task lists, consent wording and question checks happen in the form, not in your head.',
  },
  {
    to: 'to both',
    title: 'Contribution is visible',
    text: 'AdaptaBits record who took part. What they said stays with the study owner. Recognition, not payment, with a monthly prize for the top contributor.',
  },
];

// ============================================================
// LOOP DIAGRAM
// Ported from the v11 wireframe, re-coloured against design tokens
// so it themes in light and dark. Node geometry unchanged: four nodes
// sit evenly on a true ellipse, one arrowhead per clockwise segment.
// ============================================================

const LoopDiagram: React.FC = () => (
  <svg
    className="sales-loop-svg"
    viewBox="0 0 520 360"
    xmlns="http://www.w3.org/2000/svg"
    role="img"
    aria-label="The Cortex loop: a question reaches the right people, who give straight answers, which make a better decision, which prompts the next question"
  >
    <ellipse cx="260" cy="180" rx="180" ry="120" fill="none" stroke="var(--brand-primary)" strokeWidth="3" />
    <g fill="var(--brand-primary)">
      <polygon points="-9,-6 9,0 -9,6" transform="translate(387,95) rotate(34)" />
      <polygon points="-9,-6 9,0 -9,6" transform="translate(387,265) rotate(146)" />
      <polygon points="-9,-6 9,0 -9,6" transform="translate(133,265) rotate(214)" />
      <polygon points="-9,-6 9,0 -9,6" transform="translate(133,95) rotate(326)" />
    </g>
    <g fontSize="14" fill="var(--text-primary)" textAnchor="middle">
      <rect x="196" y="38" width="128" height="44" fill="var(--surface-card-current)" stroke="var(--text-primary)" strokeWidth="2" rx="4" />
      <text x="260" y="65" fontWeight="600">A question</text>

      <rect x="376" y="158" width="128" height="44" fill="var(--surface-card-current)" stroke="var(--border-strong-current)" strokeWidth="1.5" rx="4" />
      <text x="440" y="185">The right people</text>

      <rect x="196" y="278" width="128" height="44" fill="var(--surface-card-current)" stroke="var(--text-primary)" strokeWidth="2" rx="4" />
      <text x="260" y="305" fontWeight="600">Straight answers</text>

      <rect x="16" y="158" width="128" height="44" fill="var(--surface-card-current)" stroke="var(--border-strong-current)" strokeWidth="1.5" rx="4" />
      <text x="80" y="185">A better decision</text>
    </g>
    <g fontSize="11" fill="var(--text-muted)">
      <text x="260" y="20" textAnchor="middle">start here if you&rsquo;re building it</text>
      <text x="260" y="346" textAnchor="middle">start here if you&rsquo;ll tell the truth about it</text>
    </g>
    <g fill="var(--text-primary)">
      <polygon points="255,26 265,26 260,34" />
      <polygon points="255,334 265,334 260,326" />
    </g>
    <g textAnchor="middle">
      <text x="260" y="170" fontSize="15" fontWeight="600" fill="var(--text-primary)">
        cortex, <tspan fontStyle="italic" fontWeight="400">n.</tspan>
      </text>
      <text x="260" y="190" fontSize="13" fill="var(--text-secondary)">the part that thinks.</text>
      <text x="260" y="207" fontSize="13" fill="var(--text-secondary)">In this case, all of us.</text>
    </g>
  </svg>
);

// ============================================================
// SECTION COMPONENTS
// ============================================================

const LoopSection: React.FC = () => (
  <section className="sales-section" data-section="loop">
    <div className="sales-section-inner sales-loop">
      <div className="sales-loop-figure">
        <LoopDiagram />
      </div>
      <div className="sales-loop-copy">
        <h2 className="sales-heading-l">One feedback loop for all of us</h2>
        <p className="sales-body">
          Someone has a question about a product. Cortex opens it to the colleagues who can answer it, they answer
          in their own words, and the decision gets made on what people said rather than what someone assumed.
        </p>
        <p className="sales-body">
          Then the loop closes. The people who answered hear what happened. That last step is what makes it
          worth doing twice.
        </p>
      </div>
    </div>
  </section>
);

const AudiencesSection: React.FC = () => (
  <section className="sales-section sales-section--dim" data-section="audiences">
    <div className="sales-section-inner sales-audiences">
      {AUDIENCES.map((audience) => (
        <div className="sales-audience-col" key={audience.who}>
          <h2 className="sales-heading-l sales-audience-who">{audience.who}</h2>
          <p className="sales-audience-lead">{audience.lead}</p>

          <Card className="sales-outcome-card" variant="glass" hoverable={false}>
            <CardBody>
              <span className="sales-outcome-label">What you get</span>
              <p className="sales-card-text">{audience.outcome}</p>
            </CardBody>
          </Card>

          <ol className="sales-beats">
            {audience.beats.map((beat) => (
              <li className="sales-beat" key={beat.index}>
                <span className="sales-beat-index" aria-hidden="true">{beat.index}</span>
                <div>
                  <h3 className="sales-card-title">{beat.title}</h3>
                  <p className="sales-card-text">{beat.text}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  </section>
);

const MethodsSection: React.FC = () => (
  <section className="sales-section" data-section="methods">
    <div className="sales-section-inner">
      <h2 className="sales-heading-l">What kind of question is it?</h2>
      <p className="sales-micro-copy sales-methods-intro">
        Pick by the question you have, not the method you know. The form carries the rest.
      </p>

      <div className="sales-recorded">
        <div className="sales-video" aria-hidden="true">
          <span className="sales-video-play" />
          <span className="sales-video-caption">
            Sample capture from a recorded session
            <br />
            screen + voice, with the transcript running alongside
          </span>
        </div>
        <div className="sales-recorded-copy">
          <h3 className="sales-card-title">What a recorded study looks like</h3>
          <p className="sales-card-text">
            A participant opens the study, reads the task, and talks through what they&rsquo;re doing while
            their screen is captured. No moderator, no scheduling.
          </p>
          <p className="sales-card-text">
            You get the playback, the transcript and the moment they got stuck, timestamped.
          </p>
        </div>
      </div>

      <div className="sales-methods-scroll">
        <table className="sales-methods-table">
          <thead>
            <tr>
              <th>Method</th>
              <th>What it is</th>
              <th>Use it when</th>
              <th>You get</th>
              <th>Participant gives</th>
            </tr>
          </thead>
          <tbody>
            {METHODS.map((row) => (
              <tr key={row.method} className={row.highlight ? 'is-recommended' : undefined}>
                <td className="sales-methods-name">{row.method}</td>
                <td>{row.what}</td>
                <td>{row.when}</td>
                <td>{row.get}</td>
                <td className="sales-methods-time">{row.gives}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  </section>
);

const PromisesSection: React.FC = () => (
  <section className="sales-section sales-section--dim" data-section="promises">
    <div className="sales-section-inner">
      <h2 className="sales-heading-l sales-heading-center">What Cortex commits to</h2>
      <div className="sales-promises-grid">
        {PROMISES.map((promise) => (
          <Card key={promise.title} className="sales-promise-card" variant="glass">
            <CardBody>
              <span className="sales-promise-to">{promise.to}</span>
              <h3 className="sales-card-title">{promise.title}</h3>
              <p className="sales-card-text">{promise.text}</p>
            </CardBody>
          </Card>
        ))}
      </div>
    </div>
  </section>
);

const VoiceSection: React.FC = () => (
  <section className="sales-section" data-section="voice">
    <div className="sales-section-inner sales-voice">
      <blockquote className="sales-voice-quote">
        <p className="sales-body">
          I&rsquo;ve spent twenty years watching organisations decide what people need instead of finding out.
          It&rsquo;s friction not laziness, because finding out takes too much effort, recruitment takes too
          long and the results usually end up in an extended deck that nobody reads.
        </p>
        <p className="sales-body">
          Cortex removes the friction so that finding out is much easier. It enables any of us to find out
          anything about any of our products or services. It enables all of us to participate with low
          friction at a convenient time. It makes this all as easy as possible and it scales with us.
        </p>
      </blockquote>
      <p className="sales-voice-sig">Dr Nick Fine, Office of the CTO</p>
    </div>
  </section>
);

interface SectionCtaProps {
  onAccessCortex: () => void;
  isLoading: boolean;
}

const FinalCtaSection: React.FC<SectionCtaProps> = ({ onAccessCortex, isLoading }) => (
  <section className="sales-section" data-section="final-cta">
    <div className="sales-section-inner">
      <h2 className="sales-heading-l sales-heading-center">
        Got a question? Ask it. Got fifteen minutes? Answer one.
      </h2>
      <div className="sales-doors">
        {CLOSING_DOORS.map((door) => (
          <DoorCard key={door.cta} door={door} onAccessCortex={onAccessCortex} isLoading={isLoading} />
        ))}
      </div>
      {/* Feedback prompt intentionally omitted here: the global FeedbackFooter
          (App.tsx) already renders one on every page, and two stacked at the
          foot of the landing read as a duplicate. */}
    </div>
  </section>
);

// ============================================================
// MAIN EXPORT
// ============================================================

const SalesSections: React.FC<SalesSectionsProps> = ({ onAccessCortex, isLoading }) => {
  return (
    <div className="sales-sections-wrapper">
      <LoopSection />
      <AudiencesSection />
      <MethodsSection />
      <PromisesSection />
      <VoiceSection />
      <FinalCtaSection onAccessCortex={onAccessCortex} isLoading={isLoading} />
    </div>
  );
};

export default SalesSections;
