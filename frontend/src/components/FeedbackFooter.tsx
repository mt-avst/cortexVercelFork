import React, { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { submitFeedback } from '../api/client';
import { logger } from '../utils/logger';
import { CheckCircle, AlertTriangle } from 'lucide-react';

const FeedbackFooter: React.FC = () => {
  const { pathname } = useLocation();
  const [feedback, setFeedback] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Row 22 (second-pass review): /feedback carries its own dedicated form, so
  // the footer's identical "tell us how to improve Cortex" prompt stacked
  // underneath it was the same request offered twice on the one page built to
  // collect it.
  if (pathname === '/feedback' || pathname.startsWith('/feedback/')) return null;

  // D10: the study-setup wizard hides this footer too. 232px of permanent
  // chrome asking a researcher for an opinion about the product while they
  // are doing work in it is the wrong moment to ask (mav-wizard-shell) - and
  // the wizard's own header now carries a "Feedback" item instead
  // (OpportunityForm.tsx), so nothing is lost by hiding this one here. Both
  // routes named explicitly rather than matched by a shared prefix: `/new`
  // and `/:id/edit` are the only two `opportunityFormRoutes` declares
  // (OpportunityForm.routes.tsx), each with its own `/preview` child.
  const isStudySetupRoute =
    /^\/admin\/opportunities\/(new|[^/]+\/edit)(\/preview)?$/.test(pathname);
  if (isStudySetupRoute) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = feedback.trim();
    if (!trimmed) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await submitFeedback({
        category: 'other',
        feedback: trimmed,
        userAgent: navigator.userAgent,
        url: window.location.href,
      });
      setSubmitted(true);
      setFeedback('');
      setTimeout(() => setSubmitted(false), 3000);
    } catch (err: unknown) {
      logger.error('Footer feedback submit error', {
        error: err instanceof Error ? err.message : String(err),
      });
      setError('Failed to send. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <footer className="feedback-footer" role="contentinfo">
      <div className="feedback-footer__container">
        <form onSubmit={handleSubmit} className="feedback-footer__form">
          <p className="feedback-footer__prompt" id="feedback-footer-label">
            Tell us how to improve Cortex for you
          </p>
          <div className="feedback-footer__field-wrap">
            <label htmlFor="feedback-footer-textarea" className="visually-hidden">
              How we can improve Cortex
            </label>
            <textarea
              id="feedback-footer-textarea"
              className="feedback-footer__textarea"
              rows={4}
              placeholder="Your feedback..."
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              disabled={isSubmitting}
              aria-describedby={error ? 'feedback-footer-error' : submitted ? 'feedback-footer-success' : undefined}
              aria-label="How we can improve Cortex"
            />
            <div className="feedback-footer__actions">
              <button
                type="submit"
                className="btn btn-primary feedback-footer__submit"
                disabled={isSubmitting || !feedback.trim()}
              >
                {isSubmitting ? 'Sending…' : 'Send feedback'}
              </button>
              {submitted && (
                <p id="feedback-footer-success" className="feedback-footer__success" role="status">
                  <CheckCircle size={18} aria-hidden />
                  Thanks for your feedback!
                </p>
              )}
              {error && (
                <p id="feedback-footer-error" className="feedback-footer__error" role="alert">
                  <AlertTriangle size={18} aria-hidden />
                  {error}
                </p>
              )}
            </div>
          </div>
        </form>
      </div>
    </footer>
  );
};

export default FeedbackFooter;
