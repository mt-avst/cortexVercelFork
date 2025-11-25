import React from 'react';
import { OpportunityFormData } from '../../api/types';

interface ExternalLinkTabProps {
  formData: OpportunityFormData;
  validationErrors: Record<string, string>;
  handleInputChange: (field: string, value: any) => void;
}

// Helper to convert ISO string to date input value (YYYY-MM-DD)
const formatDateForInput = (isoString: string | undefined): string => {
  if (!isoString) return '';
  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return '';
    return date.toISOString().split('T')[0];
  } catch {
    return '';
  }
};

// Helper to convert date input value to ISO string
const formatDateToISO = (dateValue: string): string | undefined => {
  if (!dateValue) return undefined;
  try {
    // Set to end of day for end_date, start of day for start_date
    const date = new Date(dateValue + 'T00:00:00');
    if (isNaN(date.getTime())) return undefined;
    return date.toISOString();
  } catch {
    return undefined;
  }
};

const ExternalLinkTab: React.FC<ExternalLinkTabProps> = ({
  formData,
  validationErrors,
  handleInputChange
}) => {
  const handleDateChange = (field: 'start_date' | 'end_date', value: string) => {
    handleInputChange(field, formatDateToISO(value));
  };

  return (
    <div className="tab-pane active">
      <div className="form-section mb-5">
        <div className="d-flex align-items-center mb-4 pb-3" style={{ borderBottom: 'none' }}>
          <div>
            <h2 className="h4 mb-1" style={{ fontSize: '1.5rem', lineHeight: '1.3', fontWeight: '600', color: '#E0E0E0' }}>
              External Link
            </h2>
            <p className="mb-0" style={{ fontSize: '0.95rem', color: 'rgba(224, 224, 224, 0.7)' }}>
              Configure the external tool for polls, surveys, and unmoderated tests
            </p>
          </div>
        </div>

        <div className="row">
          <div className="col-12">
            <div className="form-group mb-3">
              <label htmlFor="external_link_optional" className="form-label mb-2" style={{ fontSize: '1rem', fontWeight: '600', color: '#E0E0E0' }}>
                External Link *
              </label>
              <div className="form-text mb-2" style={{ fontSize: '0.875rem', color: 'rgba(224, 224, 224, 0.7)' }}>
                URL to the external tool (Google Forms, SurveyMonkey, Maze, UserTesting, etc.)
              </div>
              <input
                type="url"
                id="external_link_optional"
                className={`form-control ${validationErrors.external_link_optional ? 'is-invalid' : ''}`}
                style={{ fontSize: '1.04rem', padding: '0.64rem 0.8rem', height: 'auto' }}
                value={formData.external_link_optional}
                onChange={(e) => handleInputChange('external_link_optional', e.target.value)}
                placeholder="https://forms.google.com/your-form or https://maze.co/your-test"
              />
              {validationErrors.external_link_optional && (
                <div className="fw-semibold" style={{ fontSize: '0.875rem', display: 'block', color: '#FF4E50' }}>{validationErrors.external_link_optional}</div>
              )}
            </div>
          </div>
        </div>

        {/* Study Period Section */}
        <div className="d-flex align-items-center mb-4 pb-3 mt-4" style={{ borderBottom: 'none' }}>
          <div>
            <h2 className="h4 mb-1" style={{ fontSize: '1.5rem', lineHeight: '1.3', fontWeight: '600', color: '#E0E0E0' }}>
              Study Period
            </h2>
            <p className="mb-0" style={{ fontSize: '0.95rem', color: 'rgba(224, 224, 224, 0.7)' }}>
              Set start and end dates to show a countdown timer on the study card (optional)
            </p>
          </div>
        </div>

        <div className="row">
          <div className="col-md-6">
            <div className="form-group mb-3">
              <label htmlFor="start_date" className="form-label mb-2" style={{ fontSize: '1rem', fontWeight: '600', color: '#E0E0E0' }}>
                Start Date
              </label>
              <div className="form-text mb-2" style={{ fontSize: '0.875rem', color: 'rgba(224, 224, 224, 0.7)' }}>
                When the study opens for participation
              </div>
              <input
                type="date"
                id="start_date"
                className={`form-control ${validationErrors.start_date ? 'is-invalid' : ''}`}
                style={{ fontSize: '1.04rem', padding: '0.64rem 0.8rem', height: 'auto' }}
                value={formatDateForInput(formData.start_date)}
                onChange={(e) => handleDateChange('start_date', e.target.value)}
              />
              {validationErrors.start_date && (
                <div className="fw-semibold" style={{ fontSize: '0.875rem', display: 'block', color: '#FF4E50' }}>{validationErrors.start_date}</div>
              )}
            </div>
          </div>

          <div className="col-md-6">
            <div className="form-group mb-3">
              <label htmlFor="end_date" className="form-label mb-2" style={{ fontSize: '1rem', fontWeight: '600', color: '#E0E0E0' }}>
                End Date
              </label>
              <div className="form-text mb-2" style={{ fontSize: '0.875rem', color: 'rgba(224, 224, 224, 0.7)' }}>
                When the study closes (shows countdown on card)
              </div>
              <input
                type="date"
                id="end_date"
                className={`form-control ${validationErrors.end_date ? 'is-invalid' : ''}`}
                style={{ fontSize: '1.04rem', padding: '0.64rem 0.8rem', height: 'auto' }}
                value={formatDateForInput(formData.end_date)}
                onChange={(e) => handleDateChange('end_date', e.target.value)}
              />
              {validationErrors.end_date && (
                <div className="fw-semibold" style={{ fontSize: '0.875rem', display: 'block', color: '#FF4E50' }}>{validationErrors.end_date}</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ExternalLinkTab;
