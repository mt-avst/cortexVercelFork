import React from 'react';
import { OpportunityFormData } from '../../shared/types';

interface ContentDetailsTabProps {
  formData: OpportunityFormData;
  validationErrors: Record<string, string>;
  handleInputChange: (field: string, value: any) => void;
  handleBlur?: (field: string, value: any) => void;
}

const ContentDetailsTab: React.FC<ContentDetailsTabProps> = ({
  formData,
  validationErrors,
  handleInputChange
}) => {
  return (
    <div className="tab-pane active">
      <div className="form-section mb-5">
        <div className="d-flex align-items-center mb-4 pb-3" style={{ borderBottom: 'none' }}>
          <div>
            <h2 className="h4 mb-1" style={{ fontSize: '1.5rem', lineHeight: '1.3', fontWeight: '600', color: '#E0E0E0' }}>
              Content & Details
            </h2>
            <p className="mb-0" style={{ fontSize: '0.95rem', color: 'rgba(224, 224, 224, 0.7)' }}>
              Provide additional context and participant requirements
            </p>
          </div>
        </div>

        <div className="row">
          <div className="col-md-6 col-12">
            <div className="form-group mb-3">
              <label htmlFor="description_optional" className="form-label mb-2" style={{ fontSize: '1rem', fontWeight: '600', color: '#E0E0E0' }}>
                Description (Optional)
              </label>
              <div className="form-text mb-2" style={{ fontSize: '0.875rem', color: 'rgba(224, 224, 224, 0.7)' }}>
                Detailed description of what participants will do and what to expect
              </div>
              <textarea
                id="description_optional"
                className={`form-control ${validationErrors.description_optional ? 'is-invalid' : ''}`}
                style={{ fontSize: '1.04rem', padding: '0.64rem 0.8rem', height: '120px', resize: 'vertical' }}
                value={formData.description_optional}
                onChange={(e) => handleInputChange('description_optional', e.target.value)}
                placeholder="Provide detailed information about the opportunity, what participants will be doing, what they need to prepare, etc."
              />
              {validationErrors.description_optional && (
                <div className="fw-semibold" style={{ fontSize: '0.875rem', display: 'block', color: '#FF4E50' }}>{validationErrors.description_optional}</div>
              )}
            </div>
          </div>
        </div>

        <div className="row">
          <div className="col-md-6 col-12">
            <div className="form-group mb-3">
              <label htmlFor="product_optional" className="form-label mb-2" style={{ fontSize: '1rem', fontWeight: '600', color: '#E0E0E0' }}>
                Product/Feature (Optional)
              </label>
              <div className="form-text mb-2" style={{ fontSize: '0.875rem', color: 'rgba(224, 224, 224, 0.7)' }}>
                Specific product, feature, or area this opportunity relates to
              </div>
              <input
                type="text"
                id="product_optional"
                className={`form-control ${validationErrors.product_optional ? 'is-invalid' : ''}`}
                style={{ fontSize: '1.04rem', padding: '0.64rem 0.8rem', height: 'auto' }}
                value={formData.product_optional}
                onChange={(e) => handleInputChange('product_optional', e.target.value)}
                placeholder="e.g., Mobile App, Dashboard, API, etc."
              />
              {validationErrors.product_optional && (
                <div className="fw-semibold" style={{ fontSize: '0.875rem', display: 'block', color: '#FF4E50' }}>{validationErrors.product_optional}</div>
              )}
            </div>
          </div>
        </div>

        <div className="row">
          <div className="col-6">
            <div className="form-group mb-3">
              <label htmlFor="participant_type_required" className="form-label mb-2" style={{ fontSize: '1rem', fontWeight: '600', color: '#E0E0E0' }}>
                Participant Type
              </label>
              <div className="form-text mb-2" style={{ fontSize: '0.875rem', color: 'rgba(224, 224, 224, 0.7)' }}>
                Who can participate in this opportunity
              </div>
              <select
                id="participant_type_required"
                className={`form-select ${validationErrors.participant_type_required ? 'is-invalid' : ''}`}
                style={{ fontSize: '1.04rem', padding: '0.64rem 0.8rem', height: 'auto' }}
                value={formData.participant_type_required}
                onChange={(e) => handleInputChange('participant_type_required', e.target.value)}
              >
                <option value="any" style={{ fontSize: '1.04rem', padding: '0.4rem' }}>Anyone</option>
                <option value="internal" style={{ fontSize: '1.04rem', padding: '0.4rem' }}>Internal employees only</option>
                <option value="external" style={{ fontSize: '1.04rem', padding: '0.4rem' }}>External users only</option>
                <option value="specific" style={{ fontSize: '1.04rem', padding: '0.4rem' }}>Specific criteria</option>
              </select>
              {validationErrors.participant_type_required && (
                <div className="fw-semibold" style={{ fontSize: '0.875rem', display: 'block', color: '#FF4E50' }}>{validationErrors.participant_type_required}</div>
              )}
            </div>
          </div>
          
          <div className="col-6">
            {formData.participant_type_required === 'specific' && (
              <div className="form-group mb-3">
                <label htmlFor="participant_type_specific_details" className="form-label mb-2" style={{ fontSize: '1rem', fontWeight: '600', color: '#E0E0E0' }}>
                  Specific Criteria *
                </label>
                <div className="form-text mb-2" style={{ fontSize: '0.875rem', color: 'rgba(224, 224, 224, 0.7)' }}>
                  Describe the specific participant requirements
                </div>
                <input
                  type="text"
                  id="participant_type_specific_details"
                  className={`form-control ${validationErrors.participant_type_specific_details ? 'is-invalid' : ''}`}
                  style={{ fontSize: '1.04rem', padding: '0.64rem 0.8rem', height: 'auto' }}
                  value={formData.participant_type_specific_details}
                  onChange={(e) => handleInputChange('participant_type_specific_details', e.target.value)}
                  placeholder="e.g., Users with admin access, Mobile users, etc."
                  required={formData.participant_type_required === 'specific'}
                />
                {validationErrors.participant_type_specific_details && (
                  <div className="fw-semibold" style={{ fontSize: '0.875rem', display: 'block', color: '#FF4E50' }}>{validationErrors.participant_type_specific_details}</div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ContentDetailsTab;
