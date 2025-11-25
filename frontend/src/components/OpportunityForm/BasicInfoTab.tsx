import React from 'react';
import { SESSION_DURATION } from '../../shared/constants';
import { OpportunityFormData } from '../../api/types';

interface BasicInfoTabProps {
  formData: OpportunityFormData;
  validationErrors: Record<string, string>;
  handleInputChange: (field: string, value: any) => void;
  handleBlur?: (field: string, value: any) => void;
  allowUserSubmission?: boolean;
}

const BasicInfoTab: React.FC<BasicInfoTabProps> = ({
  formData,
  validationErrors,
  handleInputChange,
  handleBlur,
  allowUserSubmission = false
}) => {
  return (
    <div className="tab-pane active">
      <div className="form-section mb-5">
        <div className="d-flex align-items-center mb-4 pb-3" style={{ borderBottom: 'none' }}>
          <div>
            <h2 className="h4 mb-1" style={{ fontSize: '1.5rem', lineHeight: '1.3', fontWeight: '600', color: '#E0E0E0' }}>
              Basic Information
            </h2>
            <p className="mb-0" style={{ fontSize: '0.95rem', color: 'rgba(224, 224, 224, 0.7)' }}>
              Configure the opportunity type and basic details
            </p>
          </div>
        </div>

        <div className="row g-3" style={{ alignItems: 'flex-start' }}>
          <div className="col-md-6">
            <div className="form-group mb-3" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              <label htmlFor="type" className="form-label mb-2" style={{ fontSize: '1rem', fontWeight: '600', minHeight: '1.5rem', lineHeight: '1.5', color: '#E0E0E0' }}>
                Research Study Type *
              </label>
              <div id="type-help" className="form-text mb-2" style={{ fontSize: '0.875rem', minHeight: '2.5rem', lineHeight: '1.4', color: 'rgba(224, 224, 224, 0.7)' }}>
                {(formData.type === 'test' || formData.type === 'interview') && 'Creates bookable time slots for interactive sessions'}
                {formData.type === 'question' && 'Creates bookable time slots for question sessions'}
                {formData.type === 'poll' && 'Opens external poll tool for quick responses'}
                {formData.type === 'survey' && 'Opens external survey tool for detailed feedback'}
                {formData.type === 'unmoderated' && 'Opens external link for self-guided testing without scheduling'}
                {!formData.type && '\u00A0'}
              </div>
              <select
                id="type"
                className={`form-select ${validationErrors.type ? 'is-invalid' : ''}`}
                style={{ fontSize: '1.04rem', padding: '0.64rem 0.8rem', height: 'auto', width: '100%' }}
                value={formData.type}
                onChange={(e) => handleInputChange('type', e.target.value)}
                aria-describedby={validationErrors.type ? 'type-error type-help' : 'type-help'}
                aria-invalid={validationErrors.type ? 'true' : 'false'}
                aria-required="true"
                required
              >
                <option value="" disabled>Please select research study type</option>
                <option value="interview" style={{ fontSize: '1.04rem', padding: '0.4rem' }}>💼 Interview - Research interview session</option>
                <option value="poll" style={{ fontSize: '1.04rem', padding: '0.4rem' }}>📊 Poll - Quick opinion gathering</option>
                <option value="question" style={{ fontSize: '1.04rem', padding: '0.4rem' }}>❓ Question - Single question session</option>
                <option value="survey" style={{ fontSize: '1.04rem', padding: '0.4rem' }}>📋 Survey - Detailed feedback collection</option>
                <option value="test" style={{ fontSize: '1.04rem', padding: '0.4rem' }}>🧪 User Test - Interactive session with participants</option>
                <option value="unmoderated" style={{ fontSize: '1.04rem', padding: '0.4rem' }}>🖥️ Unmoderated Testing - Self-guided testing via external link</option>
              </select>
                {validationErrors.type && (
                <div id="type-error" className="fw-semibold" role="alert" style={{ fontSize: '0.875rem', display: 'block', color: '#FF4E50' }}>{validationErrors.type}</div>
              )}
            </div>
          </div>
          
          {!allowUserSubmission && (
            <div className="col-md-6">
              <div className="form-group mb-3" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                <label htmlFor="status" className="form-label mb-2" style={{ fontSize: '1rem', fontWeight: '600', minHeight: '1.5rem', lineHeight: '1.5', color: '#E0E0E0' }}>Status</label>
              <div id="status-help" className="form-text mb-2" style={{ fontSize: '0.875rem', minHeight: '2.5rem', lineHeight: '1.4', color: 'rgba(224, 224, 224, 0.7)' }}>
                Draft opportunities are only visible to admins
              </div>
                <select
                  id="status"
                  className={`form-select ${validationErrors.status ? 'is-invalid' : ''}`}
                  style={{ fontSize: '1.04rem', padding: '0.64rem 0.8rem', height: 'auto', width: '100%' }}
                  value={formData.status}
                  onChange={(e) => handleInputChange('status', e.target.value)}
                  aria-describedby={validationErrors.status ? 'status-error status-help' : 'status-help'}
                  aria-invalid={validationErrors.status ? 'true' : 'false'}
                >
                  <option value="draft" style={{ fontSize: '1.04rem', padding: '0.4rem' }}>📝 Draft - Not visible to users</option>
                  <option value="published" style={{ fontSize: '1.04rem', padding: '0.4rem' }}>🌐 Published - Visible to users</option>
                </select>
                {validationErrors.status && (
                  <div id="status-error" className="fw-semibold" role="alert" style={{ fontSize: '0.875rem', display: 'block', color: '#FF4E50' }}>{validationErrors.status}</div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="row g-3" style={{ alignItems: 'flex-start' }}>
          <div className="col-md-6">
            <div className="form-group mb-3" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              <label htmlFor="title" className="form-label mb-2" style={{ fontSize: '1rem', fontWeight: '600', minHeight: '1.5rem', lineHeight: '1.5', color: '#E0E0E0' }}>
                Title *
              </label>
              <div id="title-help" className="form-text mb-2" style={{ fontSize: '0.875rem', minHeight: '2.5rem', lineHeight: '1.4', color: 'rgba(224, 224, 224, 0.7)' }}>
                Clear, concise title that describes the opportunity (4-140 characters)
              </div>
              <input
                type="text"
                id="title"
                className={`form-control ${validationErrors.title ? 'is-invalid' : ''}`}
                style={{ fontSize: '1.04rem', padding: '0.64rem 0.8rem', height: 'auto', width: '100%' }}
                value={formData.title}
                onChange={(e) => handleInputChange('title', e.target.value)}
                placeholder="e.g., User Interface Testing Session"
                aria-describedby={validationErrors.title ? 'title-error title-help' : 'title-help'}
                aria-invalid={validationErrors.title ? 'true' : 'false'}
                aria-required="true"
                required
              />
              {validationErrors.title && (
                <div id="title-error" className="fw-semibold" role="alert" style={{ fontSize: '0.875rem', display: 'block', color: '#FF4E50' }}>{validationErrors.title}</div>
              )}
            </div>
          </div>
          
          <div className="col-md-6">
            <div className="form-group mb-3" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              <label htmlFor="meeting_location_optional" className="form-label mb-2" style={{ fontSize: '1rem', fontWeight: '600', minHeight: '1.5rem', lineHeight: '1.5', color: '#E0E0E0' }}>
                Meeting Location *
              </label>
              <div id="meeting_location-help" className="form-text mb-2" style={{ fontSize: '0.875rem', minHeight: '2.5rem', lineHeight: '1.4', color: 'rgba(224, 224, 224, 0.7)' }}>
                Zoom, Google Meet, or other meeting link
              </div>
              <input
                type="text"
                id="meeting_location_optional"
                className={`form-control ${validationErrors.meeting_location_optional ? 'is-invalid' : ''}`}
                style={{ fontSize: '1.04rem', padding: '0.64rem 0.8rem', height: 'auto', width: '100%' }}
                value={formData.meeting_location_optional || ''}
                onChange={(e) => handleInputChange('meeting_location_optional', e.target.value)}
                placeholder="e.g., https://zoom.us/j/123456789 or https://meet.google.com/abc-defg-hij"
                aria-describedby={validationErrors.meeting_location_optional ? 'meeting_location-error meeting_location-help' : 'meeting_location-help'}
                aria-invalid={validationErrors.meeting_location_optional ? 'true' : 'false'}
                aria-required="true"
                required
              />
              {validationErrors.meeting_location_optional && (
                <div id="meeting_location-error" className="fw-semibold" role="alert" style={{ fontSize: '0.875rem', display: 'block', color: '#FF4E50' }}>{validationErrors.meeting_location_optional}</div>
              )}
            </div>
          </div>
        </div>

        <div className="row g-3" style={{ alignItems: 'flex-start' }}>
          <div className="col-md-6">
            <div className="form-group mb-3" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              <label htmlFor="purpose_one_liner" className="form-label mb-2" style={{ fontSize: '1rem', fontWeight: '600', minHeight: '1.5rem', lineHeight: '1.5', color: '#E0E0E0' }}>
                Purpose *
              </label>
              <div id="purpose-help" className="form-text mb-2" style={{ fontSize: '0.875rem', minHeight: '2.5rem', lineHeight: '1.4', color: 'rgba(224, 224, 224, 0.7)' }}>
                Description of what participants will do (10-180 characters)
              </div>
              <textarea
                id="purpose_one_liner"
                className={`form-control ${validationErrors.purpose_one_liner ? 'is-invalid' : ''}`}
                style={{ fontSize: '1.04rem', padding: '0.64rem 0.8rem', height: 'auto', minHeight: '4.5rem', resize: 'vertical', width: '100%' }}
                rows={3}
                value={formData.purpose_one_liner}
                onChange={(e) => handleInputChange('purpose_one_liner', e.target.value)}
                placeholder="e.g., Help us test the new dashboard interface to improve user experience"
                aria-describedby={validationErrors.purpose_one_liner ? 'purpose-error purpose-help' : 'purpose-help'}
                aria-invalid={validationErrors.purpose_one_liner ? 'true' : 'false'}
                aria-required="true"
                required
              />
              {validationErrors.purpose_one_liner && (
                <div id="purpose-error" className="fw-semibold" role="alert" style={{ fontSize: '0.875rem', display: 'block', color: '#FF4E50' }}>{validationErrors.purpose_one_liner}</div>
              )}
            </div>
          </div>

          {/* Duration - only show for test and interview types */}
          {(formData.type === 'test' || formData.type === 'interview') && (
            <div className="col-md-6">
              <div className="form-group mb-3" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                <label htmlFor="default_duration_minutes" className="form-label mb-2" style={{ fontSize: '1rem', fontWeight: '600', minHeight: '1.5rem', lineHeight: '1.5', color: '#E0E0E0' }}>
                  Default Duration (minutes) *
                </label>
                <div id="duration-help" className="form-text mb-2" style={{ fontSize: '0.875rem', minHeight: '2.5rem', lineHeight: '1.4', color: 'rgba(224, 224, 224, 0.7)' }}>
                  Expected time commitment for participants ({SESSION_DURATION.MIN_MINUTES}-{SESSION_DURATION.MAX_MINUTES} minutes)
                </div>
                <input
                  type="number"
                  id="default_duration_minutes"
                  className={`form-control ${validationErrors.default_duration_minutes ? 'is-invalid' : ''}`}
                  style={{ fontSize: '1.04rem', padding: '0.64rem 0.8rem', height: 'auto', width: '100%', maxWidth: '150px' }}
                  value={formData.default_duration_minutes}
                  onChange={(e) => handleInputChange('default_duration_minutes', parseInt(e.target.value))}
                  min={SESSION_DURATION.MIN_MINUTES}
                  max={SESSION_DURATION.MAX_MINUTES}
                  aria-describedby={validationErrors.default_duration_minutes ? 'duration-error duration-help' : 'duration-help'}
                  aria-invalid={validationErrors.default_duration_minutes ? 'true' : 'false'}
                  aria-required="true"
                  required
                />
                {validationErrors.default_duration_minutes && (
                  <div id="duration-error" className="fw-semibold" role="alert" style={{ fontSize: '0.875rem', display: 'block', color: '#FF4E50' }}>{validationErrors.default_duration_minutes}</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default BasicInfoTab;
