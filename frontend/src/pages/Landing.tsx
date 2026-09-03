import React, { useState, memo, useEffect } from 'react';
import { oidcLogin } from '../api/client';
import OrganicNeuralBackground from '../components/OrganicNeuralBackground';
import { useTheme } from '../contexts/ThemeContext';
import SalesSections from '../components/SalesSections';
import { DoorCard, OPENING_DOORS } from '../components/DoorCard';

/**
 * Landing Page Component - Adaptavist Cortex
 *
 * Rendered only while signed out (Home.tsx), so its whole audience is cold or
 * returning-but-signed-out. The first viewport therefore has to answer, in
 * order: what is this, is it for me, what do I do. The lockup answers the
 * first, the proposition the second, and the two doors the third. Nothing a
 * cold visitor needs sits behind a scroll.
 *
 * Full-screen neural cloud background, responsive typography lockup, glass UI.
 * All styles use CSS classes from _components.css for proper theming.
 */

/**
 * The hero copy, line by line. Two hammers, then what Cortex is and the two
 * things it is for, then the tagline it always had, now with a reason above
 * it. Pinned by literal in Landing.test.tsx so it cannot drift back into a
 * mood line that tells a cold visitor nothing.
 */
const HERO_HAMMERS: ReadonlyArray<string> = [
  'Building new things is hard.',
  'Building the right things is harder.',
];

const HERO_FIND_OUT: ReadonlyArray<string> = [
  'Cortex is where we find out.',
  'Where we ask the people who’ll use it.',
  'Where you say what you actually think.',
];

const HERO_TAGLINE = 'Our collective intelligence';

const Landing: React.FC = memo(() => {
  const { theme } = useTheme();
  const isDark = theme === 'dark';

  // Add landing-page class to body for header transparency
  useEffect(() => {
    document.body.classList.add('landing-page');
    return () => {
      document.body.classList.remove('landing-page');
    };
  }, []);

  const [googleLoading, setGoogleLoading] = useState(false);

  const handleLogin = () => {
    setGoogleLoading(true);
    oidcLogin();
  };

  const isLoading = googleLoading;

  return (
    <div className="landing-page-wrapper">
      {/* Dark mode keeps the animated node field, full-screen. Light mode's
          equivalent is a compact static image anchored to the text column
          below, not a full-viewport background - see landing-node-graphic. */}
      {isDark && <OrganicNeuralBackground />}

      {/* Main Layout Container - Full-screen Flexbox */}
      <div className="landing-layout-container">
        {/* Top Spacer - for navbar clearance */}
        <div style={{ flexShrink: 0, height: '1px' }} />

        {/* Hero Stack - lockup and proposition */}
        <div className="landing-hero-stack">
          {/* Shadow Shield - tight behind text only */}
          <div className="landing-shadow-shield" />

          {/* Light mode only: a compact irregular node-blob, sitting beside
              the text and above the doors - a metaphor for the company
              (many connected people), not a decorative field. Anchored to
              this column so it stays "beside the text" regardless of the
              text's own height. */}
          {!isDark && (
            <img
              // Cache-bust on every regeneration - the filename is stable but
              // the content isn't, and this asset has already been served
              // stale from a browser cache once.
              src="/images/landing-network-static.svg?v=9"
              alt=""
              aria-hidden="true"
              className="landing-node-graphic"
            />
          )}

          {/* Eyebrow */}
          <span className="landing-parent-brand">ADAPTAVIST</span>

          {/* Hero Title */}
          <h1 className="landing-product-name">
            Cortex
            <span className="landing-beta-badge">Beta v1</span>
          </h1>

          {/* Proposition - each line its own line, on purpose */}
          <div className="landing-proposition">
            <p className="landing-hammers">
              {HERO_HAMMERS.map((line) => (
                <span key={line}>{line}</span>
              ))}
            </p>
            <p className="landing-find-out">
              {HERO_FIND_OUT.map((line) => (
                <span key={line}>{line}</span>
              ))}
            </p>
            <p className="landing-tagline">{HERO_TAGLINE}</p>
          </div>
        </div>

        {/* The two doors, in the fold. Signed out, both lead to sign-in. */}
        <div className="landing-doors sales-doors">
          {OPENING_DOORS.map((door) => (
            <DoorCard key={door.cta} door={door} onAccessCortex={handleLogin} isLoading={isLoading} />
          ))}
        </div>

        {/* Quiet route in for anyone who already knows which door is theirs */}
        <button
          type="button"
          className="landing-signin-link"
          onClick={handleLogin}
          disabled={isLoading}
          aria-busy={isLoading}
        >
          {googleLoading ? (
            <span className="d-flex align-items-center gap-2">
              <span className="spinner-border spinner-border-sm" aria-hidden="true" />
              Connecting...
            </span>
          ) : (
            'Already using Cortex? Sign in'
          )}
        </button>

      </div>

      {/* Narrative - below the fold */}
      <div id="cortex-sales">
        <SalesSections onAccessCortex={handleLogin} isLoading={isLoading} />
      </div>
    </div>
  );
});

Landing.displayName = 'Landing';

export default Landing;
