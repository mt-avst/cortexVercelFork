import React from 'react';
import { Card, CardBody } from './ui/Card';
import { Badge } from './ui/Badge';

/**
 * SalesSections Component
 * 
 * Below-the-fold sales content for the Cortex landing page.
 * Structured as internal components for maintainability.
 * 
 * All headings are h2 or below (h1 is in the hero).
 * Each section carries a data-section attribute, which is how the unit test
 * addresses it. Nothing reads these for analytics, so do not say that they do.
 *
 * Every claim below is meant to be checkable against the product. The copy sat
 * unchanged from 7.1.2 to 7.55.x and drifted into three fabrications - invented
 * usage metrics, unattributed testimonials, and a participant-matching engine
 * that has never existed. SalesSections.test.tsx pins those by literal so they
 * cannot come back quietly.
 */

interface SalesSectionsProps {
  onAccessCortex: () => void;
  isLoading: boolean;
}

// ============================================================
// DATA ARRAYS - Keeps copy changes trivial and future-proof
// ============================================================

const PITCH_CARDS = [
  {
    badge: 'Studies',
    title: 'Run every kind of study',
    description: 'Interviews, tests, polls, surveys and self-guided recorded studies, authored in one place.',
  },
  {
    badge: 'Participation',
    title: 'Reach people across Adaptavist',
    description: 'Publish a study and anyone at Adaptavist can find it, book a time, or start it there and then.',
  },
  {
    badge: 'Rewards',
    title: 'Recognise contribution',
    description: 'AdaptaBits, levels and achievements, with a monthly prize for the top contributor.',
  },
];

const STEPS = [
  {
    index: 1,
    title: 'Author the study',
    description: 'Pick a type, write the task list or the questions, and set the consent wording. The form checks each step as you go.',
  },
  {
    index: 2,
    title: 'People take part',
    description: 'Participants book a slot, answer inside Cortex, or run a recorded study in their own browser.',
  },
  {
    index: 3,
    title: 'Read the results',
    description: 'Recordings, transcripts, answers and analytics all land on the study\'s own page, with CSV export.',
  },
];

const ROLE_CARDS = [
  {
    title: 'Product and engineering',
    description: 'Ship features backed by real input, not assumptions. Validate ideas and releases with colleagues who use the tools every day.',
  },
  {
    title: 'UX and research',
    description: 'Moderated interviews, native surveys and self-guided recorded studies, with bookings, consent and incentives handled in one place.',
  },
  {
    title: 'Study owners',
    description: 'Track your own studies from the admin dashboard. Per-study analytics, responses and recordings stay with the researcher who ran them.',
  },
  {
    title: 'Everyone',
    description: 'Contribute your experience, join studies that match your skills, and earn AdaptaBits for taking part.',
  },
];

const FEATURES = [
  {
    title: 'Every study type in one place',
    description: 'Interviews, tests, polls, surveys, questions and recorded studies.',
  },
  {
    title: 'Recorded studies in the browser',
    description: 'Self-guided task lists with screen and voice captured, then playback and a transcript for the research team.',
  },
  {
    title: 'Polls and surveys inside Cortex',
    description: 'Ask your questions natively, or hand off to the survey tool your team already licences.',
  },
  {
    title: 'Booking that shows the time zone',
    description: 'Capacity, automatic closing and calendar conflicts, with every time shown against its offset.',
  },
  {
    title: 'Governed consent',
    description: 'Versioned consent templates, and any wording a researcher changes is recorded as custom.',
  },
  {
    title: 'Participant data stays owner-gated',
    description: 'Recordings, transcripts and answers reach the study owner or a superadmin, not every admin.',
  },
];

const FAQS = [
  {
    question: 'Who can use Cortex?',
    answer: 'Anyone at Adaptavist. You can browse published studies without signing in, and sign in with your company account to take part.',
  },
  {
    question: 'What kinds of study can I run?',
    answer: 'Three shapes: bookable sessions for interviews and tests, polls and surveys that people answer, and self-guided studies that Cortex records in the browser.',
  },
  {
    question: 'How do I run a study?',
    // Both routes named here are behind the sign-in, and this page is read
    // signed out - so say so, rather than naming controls the reader cannot see.
    answer: 'Sign in first, then both routes are in the header. You need admin access to run a study yourself, which anyone can request from the account menu for a superadmin to approve. If you would rather someone else ran the research, Submit Research Request raises it with the research team.',
  },
  {
    question: 'Do studies record me?',
    answer: 'Only recorded studies do. They capture your screen and your voice while you work through the tasks, you see the consent wording and choose what to share before anything starts, and nothing else on Cortex records you.',
  },
  {
    question: 'How are rewards handled?',
    answer: 'Taking part earns AdaptaBits, which build levels and achievements and place you on the leaderboard. The top contributor each month wins the monthly prize.',
  },
  {
    question: 'Is my data secure?',
    answer: 'Cortex is internal to Adaptavist and needs a company sign-in. Roles are checked on the server, click tracking hashes your IP, and your answers and recordings are visible only to the study owner or a superadmin.',
  },
];

// ============================================================
// SECTION COMPONENTS
// ============================================================

const SalesPitchSection: React.FC = () => (
  <section className="sales-section sales-section--dim" data-section="pitch">
    <div className="sales-section-inner sales-grid-2">
      <div className="sales-copy-block">
        <h2 className="sales-heading-xl">Cortex turns participation into decisions</h2>
        <p className="sales-body">
          Cortex is Adaptavist&apos;s collective intelligence engine. It connects questions,
          people, and decisions so every contribution makes the organisation smarter.
        </p>
        <ul className="sales-bullets">
          <li>Run interviews, tests, polls, surveys and recorded studies from one place</li>
          <li>Publish once, and anyone at Adaptavist can find the study and take part</li>
          <li>Reward participation with AdaptaBits and build a culture of contribution</li>
        </ul>
      </div>
      <div className="sales-pitch-cards sales-stack-md">
        {PITCH_CARDS.map((card) => (
          <Card key={card.badge} className="sales-pitch-card" variant="glass">
            <CardBody>
              <Badge variant="info" className="sales-pitch-badge">{card.badge}</Badge>
              <h3 className="sales-card-title">{card.title}</h3>
              <p className="sales-card-text">{card.description}</p>
            </CardBody>
          </Card>
        ))}
      </div>
    </div>
  </section>
);

const HowItWorksSection: React.FC = () => (
  <section className="sales-section" data-section="how-it-works">
    <div className="sales-section-inner">
      <h2 className="sales-heading-l sales-heading-center">How Cortex works</h2>
      <p className="sales-body-muted sales-body-center">
        A simple three-step flow from question to evidence.
      </p>
      <div className="sales-steps-row">
        {STEPS.map((step) => (
          <Card key={step.index} className="sales-step-card" variant="glass">
            <CardBody>
              <span className="sales-step-index">{step.index}</span>
              <h3 className="sales-card-title">{step.title}</h3>
              <p className="sales-card-text">{step.description}</p>
            </CardBody>
          </Card>
        ))}
      </div>
      <p className="sales-micro-copy">Every study type follows the same three steps.</p>
    </div>
  </section>
);

const ValueByRoleSection: React.FC = () => (
  <section className="sales-section sales-section--dim" data-section="value-by-role">
    <div className="sales-section-inner">
      <h2 className="sales-heading-l sales-heading-center">Value for every role</h2>
      <div className="sales-roles-grid">
        {ROLE_CARDS.map((card) => (
          <Card key={card.title} className="sales-role-card" variant="glass">
            <CardBody>
              <h3 className="sales-card-title">{card.title}</h3>
              <p className="sales-card-text">{card.description}</p>
            </CardBody>
          </Card>
        ))}
      </div>
    </div>
  </section>
);

const FeaturesSection: React.FC = () => (
  <section className="sales-section" data-section="features">
    <div className="sales-section-inner">
      <h2 className="sales-heading-l sales-heading-center">Key features</h2>
      <div className="sales-features-grid">
        {FEATURES.map((feature) => (
          <Card key={feature.title} className="sales-feature-tile" variant="glass">
            <CardBody>
              <h3 className="sales-card-title">{feature.title}</h3>
              <p className="sales-card-text">{feature.description}</p>
            </CardBody>
          </Card>
        ))}
      </div>
    </div>
  </section>
);

/*
 * There is deliberately no social proof section. It carried three invented
 * metrics ("200+ completed studies", "3x faster", "1,000+ contributors") and
 * two unattributed quotes, under the heading "Proven inside Adaptavist", while
 * the product was in alpha and every study in the deployment was test data.
 * Nothing in the repository sourced any of the five.
 *
 * To bring it back, bring evidence: quotes with a name and a role, and counts
 * read from the dashboard aggregates rather than typed in here.
 */

const FaqSection: React.FC = () => (
  <section className="sales-section sales-section--dim" data-section="faq">
    <div className="sales-section-inner">
      <h2 className="sales-heading-l sales-heading-center">Frequently asked questions</h2>
      <div className="sales-faq-list">
        {FAQS.map((item) => (
          <details className="sales-faq-item" key={item.question}>
            <summary className="sales-faq-question">{item.question}</summary>
            <p className="sales-faq-answer">{item.answer}</p>
          </details>
        ))}
      </div>
    </div>
  </section>
);

interface FinalCtaSectionProps {
  onAccessCortex: () => void;
  isLoading: boolean;
}

const FinalCtaSection: React.FC<FinalCtaSectionProps> = ({ onAccessCortex, isLoading }) => (
  <section className="sales-cta-stripe" data-section="final-cta">
    <div className="sales-section-inner sales-cta-inner">
      <div className="sales-cta-copy">
        <h2 className="sales-heading-l">Ready to put Cortex to work?</h2>
        <p className="sales-body-muted">
          Access Cortex now or request a guided walkthrough for your team.
        </p>
      </div>
      <div className="sales-cta-buttons">
        <button 
          className={`btn-power ${isLoading ? 'disabled' : ''}`}
          onClick={onAccessCortex}
          disabled={isLoading}
          data-cta="access"
        >
          Access Cortex
          <span className="btn-arrow" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M5 12H19M19 12L12 5M19 12L12 19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </span>
        </button>
        <a 
          href="mailto:cortex@adaptavist.com?subject=Cortex%20Walkthrough%20Request"
          className="btn-outline-secondary sales-walkthrough-btn"
          data-cta="walkthrough"
        >
          Request walkthrough
        </a>
      </div>
    </div>
  </section>
);

// ============================================================
// MAIN EXPORT
// ============================================================

const SalesSections: React.FC<SalesSectionsProps> = ({ onAccessCortex, isLoading }) => {
  return (
    <div className="sales-sections-wrapper">
      <SalesPitchSection />
      <HowItWorksSection />
      <ValueByRoleSection />
      <FeaturesSection />
      <FaqSection />
      <FinalCtaSection onAccessCortex={onAccessCortex} isLoading={isLoading} />
    </div>
  );
};

export default SalesSections;

