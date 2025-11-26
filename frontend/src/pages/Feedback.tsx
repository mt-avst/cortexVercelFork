import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { submitFeedback } from '../api/client';

const Feedback: React.FC = () => {
  const { user } = useAuth();
  const [feedback, setFeedback] = useState('');
  const [category, setCategory] = useState<'bug' | 'feature' | 'question' | 'other'>('bug');
  const [submitted, setSubmitted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    
    try {
      await submitFeedback({
        category,
        feedback,
        userAgent: navigator.userAgent,
        url: window.location.href,
      });

      setSubmitted(true);
    } catch (err) {
      console.error('Error submitting feedback:', err);
      setError('Failed to submit feedback. Please try again later or email nfine@adaptavist.com directly.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Styles for dark card
  const styles = `
    /* Feedback Card Styles - Dark Glassmorphism */
    .feedback-card {
      background-color: rgba(255, 255, 255, 0.05);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 16px;
      color: #E0E0E0;
    }
    
    .feedback-card .card-header {
      background-color: transparent;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    }
    
    .feedback-card .card-body {
      background-color: transparent;
    }
    
    .feedback-card h2, 
    .feedback-card h5,
    .feedback-card .form-label,
    .feedback-card p {
      color: #E0E0E0;
    }

    .feedback-card .text-muted {
      color: rgba(224, 224, 224, 0.7) !important;
    }
    
    .feedback-card .form-control, 
    .feedback-card .form-select {
      background-color: rgba(0, 0, 0, 0.2);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: #E0E0E0;
    }
    
    .feedback-card .form-control:focus, 
    .feedback-card .form-select:focus {
      background-color: rgba(0, 0, 0, 0.3);
      border-color: rgba(255, 255, 255, 0.3);
      color: #FFFFFF;
      box-shadow: 0 0 0 0.25rem rgba(255, 255, 255, 0.1);
    }

    .feedback-card .form-text {
      color: rgba(224, 224, 224, 0.6);
    }

    .feedback-card .bg-light {
      background-color: rgba(255, 255, 255, 0.05) !important;
      color: #E0E0E0;
    }
    
    .feedback-card a {
      color: #FF4E50;
    }
    
    .feedback-card a:hover {
      color: #ff6b6d;
      text-decoration: underline;
    }
    
    .feedback-card .btn-outline-secondary {
      border-color: rgba(255, 255, 255, 0.3);
      color: #E0E0E0;
    }
    
    .feedback-card .btn-outline-secondary:hover {
      background-color: rgba(255, 255, 255, 0.1);
      border-color: rgba(255, 255, 255, 0.5);
      color: #FFFFFF;
    }
  `;

  if (submitted) {
    return (
      <>
        <style>{styles}</style>
        <div className="container mt-5" style={{ position: 'relative', zIndex: 10 }}>
          <div className="row justify-content-center">
            <div className="col-md-8">
              <div className="card feedback-card">
                <div className="card-body text-center">
                  <i className="bi bi-check-circle text-success" style={{ fontSize: '3rem' }}></i>
                  <h2 className="mt-3">Thank You!</h2>
                  <p className="lead">Your feedback has been submitted successfully.</p>
                  <p>We appreciate you taking the time to help us improve AdaptaLabs.</p>
                  <button 
                    className="btn btn-primary mt-3"
                    onClick={() => {
                      setSubmitted(false);
                      setFeedback('');
                    }}
                  >
                    Submit Another
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <style>{styles}</style>
      <div className="container mt-5" style={{ position: 'relative', zIndex: 10 }}>
        <div className="row justify-content-center">
          <div className="col-md-8">
            <div className="card feedback-card">
              <div className="card-header">
                <h2 className="mb-0">
                  <i className="bi bi-chat-left-text me-2"></i>
                  Send Feedback
                </h2>
              </div>
              <div className="card-body">
                <p className="text-muted">
                  Help us improve AdaptaLabs by sharing your feedback, reporting bugs, or suggesting features.
                </p>
                
                {error && (
                  <div 
                    className="alert" 
                    role="alert"
                    style={{
                      backgroundColor: 'rgba(220, 53, 69, 0.15)',
                      border: '1px solid rgba(220, 53, 69, 0.3)',
                      color: '#ff6b6d',
                      borderRadius: '8px',
                      padding: '1rem',
                      marginBottom: '1.5rem',
                      display: 'flex',
                      alignItems: 'center'
                    }}
                  >
                    <i className="bi bi-exclamation-triangle-fill me-2" style={{ fontSize: '1.2rem' }}></i>
                    <div>{error}</div>
                  </div>
                )}
                
                <form onSubmit={handleSubmit}>
                  <div className="mb-3">
                    <label htmlFor="category" className="form-label">
                      Category <span className="text-danger">*</span>
                    </label>
                    <select
                      id="category"
                      className="form-select"
                      value={category}
                      onChange={(e) => setCategory(e.target.value as typeof category)}
                      required
                    >
                      <option value="bug">🐛 Bug Report</option>
                      <option value="feature">💡 Feature Request</option>
                      <option value="question">❓ Question</option>
                      <option value="other">💬 Other Feedback</option>
                    </select>
                  </div>

                  <div className="mb-3">
                    <label htmlFor="feedback" className="form-label">
                      Your Feedback <span className="text-danger">*</span>
                    </label>
                    <textarea
                      id="feedback"
                      className="form-control"
                      rows={8}
                      value={feedback}
                      onChange={(e) => setFeedback(e.target.value)}
                      placeholder="Please describe your feedback, bug report, or feature request in detail..."
                      required
                      aria-describedby="feedback-help"
                    />
                    <div id="feedback-help" className="form-text">
                      Be as specific as possible. For bug reports, include steps to reproduce the issue.
                    </div>
                  </div>

                  <div className="d-flex justify-content-end">
                    <button 
                      type="submit" 
                      className="btn btn-primary"
                      disabled={isSubmitting}
                    >
                      {isSubmitting ? (
                        <>
                          <span className="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>
                          Sending...
                        </>
                      ) : (
                        <>
                      <i className="bi bi-send me-2"></i>
                      Send Feedback
                        </>
                      )}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

export default Feedback;
