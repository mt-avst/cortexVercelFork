import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { AnimationProvider } from './contexts/AnimationContext';
import ErrorBoundary from './components/ErrorBoundary';
import SkipLink from './components/SkipLink';
import Header from './components/Header';
import Home from './pages/Home';
import OpportunityDetail from './pages/OpportunityDetail';
import OpportunityForm from './pages/OpportunityForm';
import ResearchRequestForm from './pages/ResearchRequestForm';
import UnderDevelopment from './pages/UnderDevelopment';
import MyBookings from './pages/MyBookings';
import Admin from './pages/Admin';
import Settings from './pages/Settings';
import Poll from './pages/Poll';
import GamificationPage from './pages/Gamification';
import OpportunityAnalyticsPage from './pages/OpportunityAnalytics';
import Feedback from './pages/Feedback';

function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <AnimationProvider>
          <Router>
            <div className="App">
              <SkipLink />
              <Header />
              <main id="main-content" className="main" role="main">
                <div className="container">
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
                </div>
              </main>
            </div>
          </Router>
        </AnimationProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}

export default App;
