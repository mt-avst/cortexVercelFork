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
 * Each section includes data-section for analytics.
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
    title: 'Run better studies',
    description: 'Book interviews, surveys, and tests with guided templates and clear workflows.',
  },
  {
    badge: 'Participation',
    title: 'Reach the right people',
    description: 'Cortex matches your requests to relevant people and handles invites and reminders.',
  },
  {
    badge: 'Rewards',
    title: 'Recognise contribution',
    description: 'AdaptaBits and monthly prizes turn participation into visible recognition.',
  },
];

const STEPS = [
  {
    index: 1,
    title: 'Ask the question',
    description: 'Create a study, poll, or test in Cortex and define who you want to hear from.',
  },
  {
    index: 2,
    title: 'Cortex finds the people',
    description: 'Cortex matches your request to available participants and handles bookings.',
  },
  {
    index: 3,
    title: 'Turn insight into action',
    description: 'Results, recordings, and feedback are captured in one place so teams can decide and act.',
  },
];

const ROLE_CARDS = [
  {
    title: 'Product and engineering',
    description: 'Ship features backed by real input, not assumptions. Validate ideas and releases with real users and internal experts.',
  },
  {
    title: 'UX and research',
    description: 'Scale research without drowning in logistics. Manage studies, bookings, and incentives in one place.',
  },
  {
    title: 'Leaders',
    description: 'See participation and learning across the organisation. Track studies and connect insight to outcomes.',
  },
  {
    title: 'Everyone',
    description: 'Contribute your experience, join studies that match your skills, and see the impact of your insight.',
  },
];

const FEATURES = [
  {
    title: 'Unified research hub',
    description: 'All interviews, surveys, polls, and tests in one place.',
  },
  {
    title: 'Smart booking engine',
    description: 'Handles availability, time zones, and conflicts automatically.',
  },
  {
    title: 'AdaptaBits rewards',
    description: 'Built-in incentives for contributors and teams.',
  },
  {
    title: 'Governed access',
    description: 'Role-based permissions for PMs, researchers, and admins.',
  },
  {
    title: 'Insight trails',
    description: 'Link studies to decisions and track what changed as a result.',
  },
  {
    title: 'Built for our stack',
    description: 'Designed to sit alongside Jira, Confluence, and the Adaptavist toolchain.',
  },
];

const METRICS = [
  { number: '200+', label: 'completed studies' },
  { number: '3×', label: 'faster from question to decision' },
  { number: '1,000+', label: 'contributors across teams' },
];

const QUOTES = [
  'Cortex has become our default way to ask questions of the organisation. If you need input, you start here.',
  'The biggest shift is speed. We get from idea to evidence in days and it is all traceable.',
];

const FAQS = [
  {
    question: 'Who can use Cortex?',
    answer: 'Anyone at Adaptavist can take part in studies. PMs, researchers, and other teams can request studies through the platform.',
  },
  {
    question: 'How do I ask a question or run a study?',
    answer: 'Anyone can ask a question but you\'ll need to be an admin to run a study. Anyone can request admin status from the menu.',
  },
  {
    question: 'How are rewards handled?',
    answer: 'Participation is rewarded with AdaptaBits, which roll into monthly prize draws and recognition.',
  },
  {
    question: 'Is my data secure?',
    answer: 'Cortex is an internal Adaptavist platform with controlled access, permissions, and governance.',
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
          <li>Run interviews, surveys, polls, and tests from one place</li>
          <li>Reach the right people fast across teams, products, and locations</li>
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
      <p className="sales-micro-copy">From question to decision in days, not weeks.</p>
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

const SocialProofSection: React.FC = () => (
  <section className="sales-section sales-section--dim" data-section="social-proof">
    <div className="sales-section-inner sales-grid-2">
      <div className="sales-proof-metrics">
        <h2 className="sales-heading-l">Proven inside Adaptavist</h2>
        <ul className="sales-metrics-list">
          {METRICS.map((metric) => (
            <li key={metric.label} className="sales-metric-item">
              <span className="sales-proof-metric-number">{metric.number}</span>
              <span className="sales-proof-metric-label">{metric.label}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="sales-proof-quotes sales-stack-md">
        {QUOTES.map((quote, index) => (
          <Card key={index} className="sales-quote" variant="glass">
            <CardBody>
              <p className="sales-quote-text">&ldquo;{quote}&rdquo;</p>
            </CardBody>
          </Card>
        ))}
      </div>
    </div>
  </section>
);

const FaqSection: React.FC = () => (
  <section className="sales-section" data-section="faq">
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
      <SocialProofSection />
      <FaqSection />
      <FinalCtaSection onAccessCortex={onAccessCortex} isLoading={isLoading} />
    </div>
  );
};

export default SalesSections;

