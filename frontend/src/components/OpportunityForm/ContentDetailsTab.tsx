import React from 'react';

/**
 * Content & Details.
 *
 * D6 moved every field this step used to carry to the step it belongs on:
 * Description and Product join Title and Purpose on Basic Information; Participant
 * Type, Roles or skills wanted and the Study Period join the eligibility gate on
 * the Screener/Audience step. The step is intentionally left in place (2a does
 * not reshape the step set - that is 2c); it holds no inputs until then, so it
 * says so rather than presenting an empty card.
 */
const ContentDetailsTab: React.FC = () => {
  return (
    <div className="tab-pane active">
      <div className="form-section mb-5">
        <div className="d-flex align-items-center mb-4 pb-3" style={{ borderBottom: 'none' }}>
          <div>
            <h2 className="h4 mb-1 section-title" style={{ fontSize: '1.5rem', lineHeight: '1.3', fontWeight: '600' }}>
              Content & Details
            </h2>
            <p className="mb-0 section-description" style={{ fontSize: '0.95rem' }}>
              Nothing to complete here - the study details are captured on the other steps.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ContentDetailsTab;
