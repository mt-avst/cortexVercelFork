import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';

const Feedback: React.FC = () => {
  const { user } = useAuth();
  const [feedback, setFeedback] = useState('');
  const [category, setCategory] = useState<'bug' | 'feature' | 'question' | 'other'>('bug');
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    // Create mailto link with feedback details
    const subject = encodeURIComponent(`[AdaptaLabs Feedback] ${category === 'bug' ? 'Bug Report' : category === 'feature' ? 'Feature Request' : category === 'question' ? 'Question' : 'Feedback'}`);
    const body = encodeURIComponent(
      `User: ${user?.name || 'Anonymous'} (${user?.email || 'Not logged in'})\n` +
      `Category: ${category}\n\n` +
      `Feedback:\n${feedback}\n\n` +
      `---\n` +
      `Browser: ${navigator.userAgent}\n` +
      `URL: ${window.location.href}\n` +
      `Timestamp: ${new Date().toISOString()}`
    );
    
    window.location.href = `mailto:adaptalabs-support@adaptavist.com?subject=${subject}&body=${body}`;
    setSubmitted(true);
  };

  if (submitted) {
    return (
      <div className="container mt-5">
        <div className="row justify-content-center">
          <div className="col-md-8">
            <div className="card">
              <div className="card-body text-center">
                <i className="bi bi-check-circle text-success" style={{ fontSize: '3rem' }}></i>
                <h2 className="mt-3">Thank You!</h2>
                <p className="lead">Your feedback has been submitted.</p>
                <p>If your email client didn't open automatically, please send your feedback to:</p>
                <p><strong>adaptalabs-support@adaptavist.com</strong></p>
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
    );
  }

  return (
    <div className="container mt-5">
      <div className="row justify-content-center">
        <div className="col-md-8">
          <div className="card">
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

                <div className="d-flex gap-2">
                  <button type="submit" className="btn btn-primary">
                    <i className="bi bi-send me-2"></i>
                    Send Feedback
                  </button>
                  <a 
                    href="https://adaptavistlabs.atlassian.net/servicedesk/customer/portal/80"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-outline-secondary"
                  >
                    <i className="bi bi-box-arrow-up-right me-2"></i>
                    Open Service Desk
                  </a>
                </div>
              </form>

              <div className="mt-4 p-3 bg-light rounded">
                <h5 className="mb-2">Alternative Ways to Contact Us</h5>
                <ul className="mb-0">
                  <li>
                    <strong>Service Desk:</strong>{' '}
                    <a 
                      href="https://adaptavistlabs.atlassian.net/servicedesk/customer/portal/80"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Submit a ticket
                    </a>
                  </li>
                  <li>
                    <strong>Email:</strong> adaptalabs-support@adaptavist.com
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Feedback;

