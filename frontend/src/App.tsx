import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import ErrorBoundary from './components/ErrorBoundary';
import Header from './components/Header';
import Home from './pages/Home';
import OpportunityDetail from './pages/OpportunityDetail';
import OpportunityForm from './pages/OpportunityForm';
import MyBookings from './pages/MyBookings';
import Admin from './pages/Admin';
import Poll from './pages/Poll';

function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <Router>
          <div className="App">
            <Header />
            <main className="main">
              <div className="container">
                <Routes>
                  <Route path="/" element={<Home />} />
                  <Route path="/opportunities/:id" element={<OpportunityDetail />} />
                  <Route path="/poll/:id" element={<Poll />} />
                  <Route path="/admin" element={<Admin />} />
                  <Route path="/admin/opportunities/new" element={<OpportunityForm />} />
                  <Route path="/admin/opportunities/:id/edit" element={<OpportunityForm />} />
                  <Route path="/my-bookings" element={<MyBookings />} />
                </Routes>
              </div>
            </main>
          </div>
        </Router>
      </AuthProvider>
    </ErrorBoundary>
  );
}

export default App;
