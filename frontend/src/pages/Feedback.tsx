import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { submitFeedback } from '../api/client';
import { logger } from '../utils/logger';
import { CheckCircle, MessageSquare, AlertTriangle, Send, X } from 'lucide-react';

const Feedback: React.FC = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [feedback, setFeedback] = useState('');
  const [category, setCategory] = useState<'bug' | 'feature' | 'question' | 'other'>('bug');
  const [submitted, setSubmitted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClose = () => {
    navigate(-1); // Go back to previous page
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = feedback.trim();
    if (!trimmed) return;
    setIsSubmitting(true);
    setError(null);

    try {
      await submitFeedback({
        category,
        feedback: trimmed,
        userAgent: navigator.userAgent,
        url: window.location.href,
      });

      setSubmitted(true);
    } catch (error: unknown) {
      logger.error('Error submitting feedback', {
        error: error instanceof Error ? error : undefined,
        errorMessage: error instanceof Error ? error.message : String(error)
      });
      setError('Failed to submit feedback. Please try again later or email nfine@adaptavist.com directly.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Theme-aware styles for feedback card
  const styles = `
    /* Feedback Card Styles - Theme Aware */
    .feedback-card {
      background: var(--bg-card);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid var(--border-card);
      border-radius: 16px;
      color: var(--text-body);
    }
    
    .feedback-card .card-header {
      background-color: transparent;
      border-bottom: 1px solid var(--border-card);
    }
    
    .feedback-card .card-body {
      background-color: transparent;
    }
    
    .feedback-card h2, 
    .feedback-card h5,
    .feedback-card .form-label,
    .feedback-card p {
      color: var(--text-primary);
    }

    .feedback-card .text-muted {
      color: var(--text-muted) !important;
    }
    
    .feedback-card .form-control, 
    .feedback-card .form-select {
      background-color: var(--bg-input);
      border: 1px solid var(--border-card);
      color: var(--text-body);
    }
    
    .feedback-card .form-control:focus, 
    .feedback-card .form-select:focus {
      background-color: var(--bg-input-focus);
      border-color: var(--focus-ring);
      color: var(--text-primary);
      box-shadow: 0 0 0 0.25rem var(--focus-ring-color);
    }

    .feedback-card .form-text {
      color: var(--text-muted);
    }

    .feedback-card .bg-light {
      background-color: var(--bg-tab) !important;
      color: var(--text-body);
    }
    
    .feedback-card a {
      color: var(--link);
    }
    
    .feedback-card a:hover {
      color: var(--link-hover);
      text-decoration: underline;
    }
    
    .feedback-card .btn-outline-secondary {
      border-color: var(--border-card);
      color: var(--text-body);
    }
    
    .feedback-card .btn-outline-secondary:hover {
      background-color: var(--bg-hover);
      border-color: var(--brand-primary);
      color: var(--text-primary);
    }
    
    /* Dark theme specific overrides */
    body.theme-dark .feedback-card {
      background: rgba(30, 30, 50, 0.95);
      border: 1px solid rgba(255, 255, 255, 0.1);
    }
    
    body.theme-dark .feedback-card .form-control,
    body.theme-dark .feedback-card .form-select {
      background-color: rgba(0, 0, 0, 0.2);
      border-color: rgba(255, 255, 255, 0.1);
    }
    
    body.theme-dark .feedback-card .form-control:focus,
    body.theme-dark .feedback-card .form-select:focus {
      background-color: rgba(0, 0, 0, 0.3);
      border-color: var(--focus-ring);
    }
    
    /* Light theme specific overrides */
    body.theme-light .feedback-card {
      background: rgba(255, 255, 255, 0.85);
      border: 1px solid rgba(0, 0, 0, 0.1);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
    }
    
    body.theme-light .feedback-card .form-control,
    body.theme-light .feedback-card .form-select {
      background-color: rgba(255, 255, 255, 0.9);
      border-color: rgba(0, 0, 0, 0.12);
    }
  `;

  if (submitted) {
    return (
      <>
        <style>{styles}</style>
        <div className="container mt-5" style={{ position: 'relative', zIndex: 10 }}>
          <div className="row justify-content-center">
            <div className="col-md-8">
              <div className="card feedback-card" style={{ position: 'relative' }}>
                <button
                  type="button"
                  onClick={handleClose}
                  aria-label="Close"
                  style={{
                    position: 'absolute',
                    top: '16px',
                    right: '16px',
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '8px',
                    borderRadius: '8px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--text-muted)',
                    transition: 'all 0.2s ease'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = 'var(--bg-hover)';
                    e.currentTarget.style.color = 'var(--text-primary)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                    e.currentTarget.style.color = 'var(--text-muted)';
                  }}
                >
                  <X size={24} />
                </button>
                <div className="card-body text-center">
                  <CheckCircle size={48} className="text-success" />
                  <h2 className="mt-3">Thank You!</h2>
                  <p className="lead">Your feedback has been submitted successfully.</p>
                  <p>We appreciate you taking the time to help us improve Cortex.</p>
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
              <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h2 className="mb-0">
                  Send Feedback
                </h2>
                <button
                  type="button"
                  onClick={handleClose}
                  aria-label="Close"
                  style={{
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '8px',
                    borderRadius: '8px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--text-muted)',
                    transition: 'all 0.2s ease'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = 'var(--bg-hover)';
                    e.currentTarget.style.color = 'var(--text-primary)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                    e.currentTarget.style.color = 'var(--text-muted)';
                  }}
                >
                  <X size={24} />
                </button>
              </div>
              <div className="card-body">
                <p className="text-muted">
                  Help us improve Cortex by sharing your feedback, reporting bugs, or suggesting features.
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
                    <AlertTriangle size={20} className="me-2" />
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
                      <Send size={16} className="me-2" />
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
