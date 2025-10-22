import React from 'react';
import { OpportunityFormData } from '../../shared/types';

interface ExternalLinkTabProps {
  formData: OpportunityFormData;
  validationErrors: Record<string, string>;
  handleInputChange: (field: string, value: any) => void;
}

const ExternalLinkTab: React.FC<ExternalLinkTabProps> = ({
  formData,
  validationErrors,
  handleInputChange
}) => {
  return (
    <div className="tab-pane active">
      <div className="form-section mb-5">
        <div className="d-flex align-items-center mb-4 pb-3" style={{ borderBottom: 'none' }}>
          <div>
            <h2 className="h4 mb-1 text-dark" style={{ fontSize: '1.5rem', lineHeight: '1.3', fontWeight: 'bold' }}>
              External Link
            </h2>
            <p className="text-muted mb-0" style={{ fontSize: '0.95rem' }}>
              Configure the external tool for polls and surveys
            </p>
          </div>
        </div>

        <div className="row">
          <div className="col-12">
            <div className="form-group mb-3">
              <label htmlFor="external_link_optional" className="form-label text-dark mb-2" style={{ fontSize: '1rem', fontWeight: 'bold' }}>
                External Link *
              </label>
              <div className="form-text text-muted mb-2" style={{ fontSize: '0.875rem' }}>
                URL to the external poll or survey tool (Google Forms, SurveyMonkey, etc.)
              </div>
              <input
                type="url"
                id="external_link_optional"
                className={`form-control ${validationErrors.external_link_optional ? 'is-invalid' : ''}`}
                style={{ fontSize: '1.04rem', padding: '0.64rem 0.8rem', height: 'auto' }}
                value={formData.external_link_optional}
                onChange={(e) => handleInputChange('external_link_optional', e.target.value)}
                placeholder="https://forms.google.com/your-poll-or-survey"
              />
              {validationErrors.external_link_optional && (
                <div className="invalid-feedback fw-semibold">{validationErrors.external_link_optional}</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ExternalLinkTab;
