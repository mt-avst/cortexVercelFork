import React, { Suspense, lazy } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { NavigationGuardProvider } from './contexts/NavigationGuardContext';
import ErrorBoundary from './components/ErrorBoundary';
import SkipLink from './components/SkipLink';
import Header from './components/Header';
import ScrollToTop from './components/ScrollToTop';
import LoadingSpinner from './components/LoadingSpinner';
import FeedbackFooter from './components/FeedbackFooter';
import { opportunityFormRoutes } from './pages/OpportunityForm.routes';

// Eagerly load the home page for fast initial load
import Home from './pages/Home';

// Lazy load all other pages for better initial bundle size
const OpportunityDetail = lazy(() => import('./pages/OpportunityDetail'));
const OpportunityForm = lazy(() => import('./pages/OpportunityForm'));
const MyBookings = lazy(() => import('./pages/MyBookings'));
const Admin = lazy(() => import('./pages/Admin'));
const Settings = lazy(() => import('./pages/Settings'));
const SurveySession = lazy(() => import('./pages/SurveySession'));
const GamificationPage = lazy(() => import('./pages/Gamification'));
const OpportunityAnalyticsPage = lazy(() => import('./pages/OpportunityAnalytics'));
const OpportunityOverviewPage = lazy(() => import('./pages/OpportunityOverview'));
const SessionReviewPage = lazy(() => import('./pages/SessionReview'));
const Feedback = lazy(() => import('./pages/Feedback'));
const Studies = lazy(() => import('./pages/Studies'));
const StudyEditor = lazy(() => import('./pages/StudyEditor'));
const RecordingSession = lazy(() => import('./pages/RecordingSession'));

// Page loading fallback component
const PageLoader = () => (
  <div className="d-flex justify-content-center align-items-center" style={{ minHeight: '50vh' }}>
    <LoadingSpinner size="large" text="Loading..." />
  </div>
);

/**
 * The standard app chrome (skip link, header, container, footer) that wraps
 * every page except the participant recording surface. A pathless layout route
 * renders it around an <Outlet />, so `/session/:token` (declared as a sibling)
 * renders as a full-page takeover with no chrome: the recording screen must not
 * offer a one-click exit (a header nav link bypasses the beforeunload guard)
 * while a recording is only held in memory.
 */
function AppChromeLayout() {
  return (
    <>
      <SkipLink />
      {/*
        The Header and the page below share ONE navigation guard (WZ-13). The
        provider has to sit above both so a page (e.g. a dirty OpportunityForm)
        can register a guard that the Header's links consult - the two live in
        different subtrees and could not reach each other otherwise.
      */}
      <NavigationGuardProvider>
        <Header />
        <main id="main-content" className="main" role="main">
          <div className="container">
            <Suspense fallback={<PageLoader />}>
              <Outlet />
            </Suspense>
          </div>
        </main>
      </NavigationGuardProvider>
      <FeedbackFooter />
    </>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <ThemeProvider>
          <Router>
            <ScrollToTop />
            <div className="App">
              <Routes>
                {/* Chrome-less participant recording surface (B6). */}
                <Route
                  path="/session/:token"
                  element={
                    <Suspense fallback={<PageLoader />}>
                      <RecordingSession />
                    </Suspense>
                  }
                />

                {/* Row 22 (second-pass review): chrome-less for the same
                    reason as the recording surface above - a participant
                    mid-poll or mid-survey should not be handed a one-click
                    exit via the header nav, or an unrelated "tell us how to
                    improve Cortex" form stacked under their answers. Keyed on
                    a session token, because every answer is written against a
                    runtime session and there is nothing to store into until
                    one exists. This replaces `/poll/:id`, a placeholder
                    present since v6.0.0, linked from nowhere, which an
                    opportunity id alone could never have made work. */}
                <Route
                  path="/survey/:token"
                  element={
                    <Suspense fallback={<PageLoader />}>
                      <SurveySession />
                    </Suspense>
                  }
                />

                {/* Everything else keeps the standard app chrome. */}
                <Route element={<AppChromeLayout />}>
                  <Route path="/" element={<Home />} />
                  <Route path="/opportunities/:id" element={<OpportunityDetail />} />
                  {/* No `/submit-research-request` route. A non-admin who wants
                      research run raises it on the service desk, which Header
                      links out to - see #46. The route used to render the
                      Under Development placeholder, which promised an in-app
                      form that was never wired up. The catch-all below now
                      sends any stale link home. */}
                  <Route path="/admin" element={<Admin />} />
                  <Route path="/admin/settings" element={<Settings />} />
                  <Route path="/admin/studies" element={<Studies />} />
                  <Route path="/admin/studies/new" element={<StudyEditor />} />
                  <Route path="/admin/studies/:id/edit" element={<StudyEditor />} />
                  {/*
                      Declared in OpportunityForm.routes so the preview test can
                      assert on the SAME declaration rather than a copy of it -
                      see there for why the nesting is load-bearing. */}
                  {opportunityFormRoutes(<OpportunityForm />)}
                  {/* cto/AdaptaLabs#163: the study's own overview page. React
                      Router ranks a static segment (`new`, `edit`, `analytics`)
                      above a dynamic one, so this never swallows the routes
                      above or below it - it only matches when nothing more
                      specific does. */}
                  <Route path="/admin/opportunities/:id" element={<OpportunityOverviewPage />} />
                  <Route path="/admin/opportunities/:id/analytics" element={<OpportunityAnalyticsPage />} />
                  <Route path="/admin/opportunities/:id/sessions/:sessionId/review" element={<SessionReviewPage />} />
                  <Route path="/my-bookings" element={<MyBookings />} />
                  <Route path="/gamification" element={<GamificationPage />} />
                  <Route path="/feedback" element={<Feedback />} />
                  {/* C1: catch-all so an unmatched route (previously blank) lands
                      somewhere sensible rather than rendering nothing. */}
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Route>
              </Routes>
            </div>
          </Router>
        </ThemeProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}

export default App;
