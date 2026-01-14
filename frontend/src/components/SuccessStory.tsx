import React, { memo } from 'react';
import { Sparkles, CheckCircle } from 'lucide-react';

/**
 * Success Story Component
 * 
 * Displays a "Your Progress in Action" section with a success story
 * demonstrating how user feedback has impacted product development.
 * 
 * This serves as a behavioral loop closer - showing users the value of participation.
 */

const SuccessStory: React.FC = memo(() => {
  return (
    <div className="success-story" role="region" aria-labelledby="success-story-title">
      <div className="success-story-header">
        <Sparkles size={18} className="success-story-icon" aria-hidden="true" />
        <h2 id="success-story-title" className="success-story-title">Your Progress in Action</h2>
      </div>
      <div className="success-story-content">
        <div className="success-story-badge">
          <CheckCircle size={14} aria-hidden="true" />
          <span>Recently Shipped</span>
        </div>
        <p className="success-story-text">
          The new <strong>Dashboard Filter</strong> was launched this month thanks to feedback from{' '}
          <span className="success-story-highlight">87 users</span> in the Quick Feedback Questions study.
        </p>
      </div>
    </div>
  );
});

SuccessStory.displayName = 'SuccessStory';

export default SuccessStory;













