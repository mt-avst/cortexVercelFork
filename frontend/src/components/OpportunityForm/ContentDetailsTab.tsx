import React from 'react';
import { OpportunityFormData } from '../../shared/types';

interface ContentDetailsTabProps {
  formData: OpportunityFormData;
  validationErrors: Record<string, string>;
  handleInputChange: (field: string, value: any) => void;
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
            <h2 className="h4 mb-1 text-dark" style={{ fontSize: '1.5rem', lineHeight: '1.3', fontWeight: 'bold' }}>
              Content & Details
            </h2>
            <p className="text-muted mb-0" style={{ fontSize: '0.95rem' }}>
              Provide additional context and participant requirements
            </p>
          </div>
        </div>

        <div className="row">
          <div className="col-md-6 col-12">
            <div className="form-group mb-3">
              <label htmlFor="description_optional" className="form-label text-dark mb-2" style={{ fontSize: '1rem', fontWeight: 'bold' }}>
                Description (Optional)
              </label>
              <div className="form-text text-muted mb-2" style={{ fontSize: '0.875rem' }}>
                Detailed description of what participants will do and what to expect
              </div>
              <textarea
                id="description_optional"
                className={`form-control ${validationErrors.description_optional ? 'is-invalid' : ''}`}
                style={{ fontSize: '1.04rem', padding: '0.64rem 0.8rem', height: '120px', resize: 'vertical', width: '50%' }}
                value={formData.description_optional}
                onChange={(e) => handleInputChange('description_optional', e.target.value)}
                placeholder="Provide detailed information about the opportunity, what participants will be doing, what they need to prepare, etc."
              />
              {validationErrors.description_optional && (
                <div className="invalid-feedback fw-semibold">{validationErrors.description_optional}</div>
              )}
            </div>
          </div>
        </div>

        <div className="row">
          <div className="col-md-6 col-12">
            <div className="form-group mb-3">
              <label htmlFor="product_optional" className="form-label text-dark mb-2" style={{ fontSize: '1rem', fontWeight: 'bold' }}>
                Product/Feature (Optional)
              </label>
              <div className="form-text text-muted mb-2" style={{ fontSize: '0.875rem' }}>
                Specific product, feature, or area this opportunity relates to
              </div>
              <input
                type="text"
                id="product_optional"
                className={`form-control ${validationErrors.product_optional ? 'is-invalid' : ''}`}
                style={{ fontSize: '1.04rem', padding: '0.64rem 0.8rem', height: 'auto', width: '50%' }}
                value={formData.product_optional}
                onChange={(e) => handleInputChange('product_optional', e.target.value)}
                placeholder="e.g., Mobile App, Dashboard, API, etc."
              />
              {validationErrors.product_optional && (
                <div className="invalid-feedback fw-semibold">{validationErrors.product_optional}</div>
              )}
            </div>
          </div>
        </div>

        <div className="row">
          <div className="col-6">
            <div className="form-group mb-3">
              <label htmlFor="participant_type_required" className="form-label text-dark mb-2" style={{ fontSize: '1rem', fontWeight: 'bold' }}>
                Participant Type
              </label>
              <div className="form-text text-muted mb-2" style={{ fontSize: '0.875rem' }}>
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
                <div className="invalid-feedback fw-semibold">{validationErrors.participant_type_required}</div>
              )}
            </div>
          </div>
          
          <div className="col-6">
            {formData.participant_type_required === 'specific' && (
              <div className="form-group mb-3">
                <label htmlFor="participant_type_specific_details" className="form-label text-dark mb-2" style={{ fontSize: '1rem', fontWeight: 'bold' }}>
                  Specific Criteria *
                </label>
                <div className="form-text text-muted mb-2" style={{ fontSize: '0.875rem' }}>
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
                  <div className="invalid-feedback fw-semibold">{validationErrors.participant_type_specific_details}</div>
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
