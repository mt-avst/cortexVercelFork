import React, { Suspense, lazy } from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { ThemeProvider } from './contexts/ThemeContext';
import ErrorBoundary from './components/ErrorBoundary';
import SkipLink from './components/SkipLink';
import Header from './components/Header';
import LoadingSpinner from './components/LoadingSpinner';
import BackgroundAnimation from './components/BackgroundAnimation';
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
const Feedback = lazy(() => import('./pages/Feedback'));

// Page loading fallback component
const PageLoader = () => (
  <div className="d-flex justify-content-center align-items-center" style={{ minHeight: '50vh' }}>
    <LoadingSpinner size="large" text="Loading..." />
  </div>
);

function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <ThemeProvider>
          <Router>
            <div className="App">
              <SkipLink />
              <BackgroundAnimation />
              <Header />
              <main id="main-content" className="main" role="main">
                <div className="container">
                  <Suspense fallback={<PageLoader />}>
                    <Routes>
                      <Route path="/" element={<Home />} />
                      <Route path="/opportunities/:id" element={<OpportunityDetail />} />
                      <Route path="/poll/:id" element={<Poll />} />
                      <Route path="/submit-research-request" element={<UnderDevelopment />} />
                      <Route path="/admin" element={<Admin />} />
                      <Route path="/admin/settings" element={<Settings />} />
                      <Route path="/admin/opportunities/new" element={<OpportunityForm />} />
                      <Route path="/admin/opportunities/:id/edit" element={<OpportunityForm />} />
                      <Route path="/admin/opportunities/:id/analytics" element={<OpportunityAnalyticsPage />} />
                      <Route path="/my-bookings" element={<MyBookings />} />
                      <Route path="/gamification" element={<GamificationPage />} />
                      <Route path="/feedback" element={<Feedback />} />
                    </Routes>
                  </Suspense>
                </div>
              </main>
              <FeedbackFooter />
            </div>
          </Router>
        </ThemeProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}

export default App;
