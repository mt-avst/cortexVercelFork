import React, { Suspense, lazy } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { ThemeProvider } from './contexts/ThemeContext';
import ErrorBoundary from './components/ErrorBoundary';
import SkipLink from './components/SkipLink';
import Header from './components/Header';
import LoadingSpinner from './components/LoadingSpinner';
import FeedbackFooter from './components/FeedbackFooter';

// Eagerly load the home page for fast initial load
import Home from './pages/Home';

// Lazy load all other pages for better initial bundle size
const OpportunityDetail = lazy(() => import('./pages/OpportunityDetail'));
const OpportunityForm = lazy(() => import('./pages/OpportunityForm'));
const UnderDevelopment = lazy(() => import('./pages/UnderDevelopment'));
const MyBookings = lazy(() => import('./pages/MyBookings'));
const Admin = lazy(() => import('./pages/Admin'));
const Settings = lazy(() => import('./pages/Settings'));
const Poll = lazy(() => import('./pages/Poll'));
const GamificationPage = lazy(() => import('./pages/Gamification'));
const OpportunityAnalyticsPage = lazy(() => import('./pages/OpportunityAnalytics'));
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
      <Header />
      <main id="main-content" className="main" role="main">
        <div className="container">
          <Suspense fallback={<PageLoader />}>
            <Outlet />
          </Suspense>
        </div>
      </main>
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

                {/* Everything else keeps the standard app chrome. */}
                <Route element={<AppChromeLayout />}>
                  <Route path="/" element={<Home />} />
                  <Route path="/opportunities/:id" element={<OpportunityDetail />} />
                  <Route path="/poll/:id" element={<Poll />} />
                  <Route path="/submit-research-request" element={<UnderDevelopment />} />
                  <Route path="/admin" element={<Admin />} />
                  <Route path="/admin/settings" element={<Settings />} />
                  <Route path="/admin/studies" element={<Studies />} />
                  <Route path="/admin/studies/new" element={<StudyEditor />} />
                  <Route path="/admin/studies/:id/edit" element={<StudyEditor />} />
                  <Route path="/admin/opportunities/new" element={<OpportunityForm />} />
                  <Route path="/admin/opportunities/:id/edit" element={<OpportunityForm />} />
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
