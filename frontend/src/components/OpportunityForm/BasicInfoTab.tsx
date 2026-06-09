import React from 'react';
import { SESSION_DURATION } from '../../shared/constants';
import { OpportunityFormData } from '../../api/types';

/** Form field value type for opportunity form handlers */
type FormFieldValue = string | number | boolean | undefined;

interface BasicInfoTabProps {
  formData: OpportunityFormData;
  validationErrors: Record<string, string>;
  handleInputChange: (field: string, value: FormFieldValue) => void;
  handleBlur?: (field: string, value: FormFieldValue) => void;
  allowUserSubmission?: boolean;
}

/**
 * Date-only fields (study period): avoid timezone shifts.
 * Parsing "YYYY-MM-DD" as local midnight then calling toISOString() shifts the calendar
 * day for timezones ahead of UTC (e.g. APAC), so the picker appears to reject "future" dates.
 * We store the chosen calendar day as noon UTC; display uses UTC Y/M/D.
 */
const formatDateForInput = (isoString: string | undefined): string => {
  if (!isoString) return '';
  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return '';
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  } catch {
    return '';
  }
};

/** Parse YYYY-MM-DD from <input type="date"> as that calendar day at noon UTC (stable round-trip). */
const formatDateToISO = (dateValue: string): string | undefined => {
  if (!dateValue) return undefined;
  const parts = dateValue.split('-').map((p) => parseInt(p, 10));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return undefined;
  const [year, month, day] = parts;
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const ms = Date.UTC(year, month - 1, day, 12, 0, 0);
  const date = new Date(ms);
  if (isNaN(date.getTime())) return undefined;
  return date.toISOString();
};

const BasicInfoTab: React.FC<BasicInfoTabProps> = ({
  formData,
  validationErrors,
  handleInputChange,
  handleBlur,
  allowUserSubmission = false
}) => {
  const handleDateChange = (field: 'start_date' | 'end_date', value: string) => {
    handleInputChange(field, formatDateToISO(value));
  };

  const isExternalLinkType = ['poll', 'survey', 'question', 'unmoderated'].includes(formData.type);
  return (
    <div className="tab-pane active">
      <div className="form-section mb-5">
        <div className="d-flex align-items-center mb-4 pb-3" style={{ borderBottom: 'none' }}>
          <div>
            <h2 className="h4 mb-1 section-title" style={{ fontSize: '1.5rem', lineHeight: '1.3', fontWeight: '600' }}>
              Basic Information
            </h2>
            <p className="mb-0 section-description" style={{ fontSize: '0.95rem' }}>
              Configure the opportunity type and basic details
            </p>
          </div>
        </div>

        <div className="row g-3" style={{ alignItems: 'flex-start' }}>
          <div className="col-md-6">
            <div className="form-group mb-3" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              <label htmlFor="type" className="form-label mb-2" style={{ fontSize: '1rem', fontWeight: '600', minHeight: '1.5rem', lineHeight: '1.5' }}>
                Research Study Type *
              </label>
              <div id="type-help" className="form-text mb-2" style={{ fontSize: '0.875rem', minHeight: '2.5rem', lineHeight: '1.4' }}>
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
                <div id="type-error" className="fw-semibold validation-error" role="alert" style={{ fontSize: '0.875rem', display: 'block' }}>{validationErrors.type}</div>
              )}
            </div>
          </div>
          
          {!allowUserSubmission && (
            <div className="col-md-6">
              <div className="form-group mb-3" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                <label htmlFor="status" className="form-label mb-2" style={{ fontSize: '1rem', fontWeight: '600', minHeight: '1.5rem', lineHeight: '1.5' }}>Status</label>
              <div id="status-help" className="form-text mb-2" style={{ fontSize: '0.875rem', minHeight: '2.5rem', lineHeight: '1.4' }}>
                {formData.status === 'draft' ? (
                  <strong className="text-warning">⚠️ DRAFT - Not visible to users. Change to Published to make visible.</strong>
                ) : (
                  'Published opportunities are visible to all users'
                )}
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
                  <div id="status-error" className="fw-semibold validation-error" role="alert" style={{ fontSize: '0.875rem', display: 'block' }}>{validationErrors.status}</div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="row g-3" style={{ alignItems: 'flex-start' }}>
          <div className={formData.type === 'test' || formData.type === 'interview' ? 'col-md-6' : 'col-md-12'}>
            <div className="form-group mb-3" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              <label htmlFor="title" className="form-label mb-2" style={{ fontSize: '1rem', fontWeight: '600', minHeight: '1.5rem', lineHeight: '1.5' }}>
                Title *
              </label>
              <div id="title-help" className="form-text mb-2" style={{ fontSize: '0.875rem', minHeight: '2.5rem', lineHeight: '1.4' }}>
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
                <div id="title-error" className="fw-semibold validation-error" role="alert" style={{ fontSize: '0.875rem', display: 'block' }}>{validationErrors.title}</div>
              )}
            </div>
          </div>

          {/* Meeting Location - only relevant for session-based types */}
          {(formData.type === 'test' || formData.type === 'interview') && (
            <div className="col-md-6">
              <div className="form-group mb-3" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                <label htmlFor="meeting_location_optional" className="form-label mb-2" style={{ fontSize: '1rem', fontWeight: '600', minHeight: '1.5rem', lineHeight: '1.5' }}>
                  Meeting Location *
                </label>
                <div id="meeting_location-help" className="form-text mb-2" style={{ fontSize: '0.875rem', minHeight: '2.5rem', lineHeight: '1.4' }}>
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
                  <div id="meeting_location-error" className="fw-semibold validation-error" role="alert" style={{ fontSize: '0.875rem', display: 'block' }}>{validationErrors.meeting_location_optional}</div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="row g-3" style={{ alignItems: 'flex-start' }}>
          <div className="col-md-6">
            <div className="form-group mb-3" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              <label htmlFor="purpose_one_liner" className="form-label mb-2" style={{ fontSize: '1rem', fontWeight: '600', minHeight: '1.5rem', lineHeight: '1.5' }}>
                Purpose *
              </label>
              <div id="purpose-help" className="form-text mb-2" style={{ fontSize: '0.875rem', minHeight: '2.5rem', lineHeight: '1.4' }}>
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
                <div id="purpose-error" className="fw-semibold validation-error" role="alert" style={{ fontSize: '0.875rem', display: 'block' }}>{validationErrors.purpose_one_liner}</div>
              )}
            </div>
          </div>

          {/* Duration - only show for test and interview types */}
          {(formData.type === 'test' || formData.type === 'interview') && (
            <div className="col-md-6">
              <div className="form-group mb-3" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                <label htmlFor="default_duration_minutes" className="form-label mb-2" style={{ fontSize: '1rem', fontWeight: '600', minHeight: '1.5rem', lineHeight: '1.5' }}>
                  Default Duration (minutes) *
                </label>
                <div id="duration-help" className="form-text mb-2" style={{ fontSize: '0.875rem', minHeight: '2.5rem', lineHeight: '1.4' }}>
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
                  <div id="duration-error" className="fw-semibold validation-error" role="alert" style={{ fontSize: '0.875rem', display: 'block' }}>{validationErrors.default_duration_minutes}</div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Study Period - only show for external link types (poll, survey, question, unmoderated) */}
        {isExternalLinkType && (
          <div className="row g-3 mt-2" style={{ alignItems: 'flex-start' }}>
            <div className="col-12 mb-2">
              <h3 className="h6 mb-1" style={{ fontSize: '1.1rem', fontWeight: '600' }}>
                Study Period
              </h3>
              <p className="mb-0" style={{ fontSize: '0.875rem' }}>
                Set dates to show a countdown timer on the study card (optional)
              </p>
            </div>
            <div className="col-md-6">
              <div className="form-group mb-3" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                <label htmlFor="start_date" className="form-label mb-2" style={{ fontSize: '1rem', fontWeight: '600', minHeight: '1.5rem', lineHeight: '1.5' }}>
                  Start Date
                </label>
                <div id="start_date-help" className="form-text mb-2" style={{ fontSize: '0.875rem', minHeight: '1.5rem', lineHeight: '1.4' }}>
                  When the study opens for participation
                </div>
                <input
                  type="date"
                  id="start_date"
                  className={`form-control ${validationErrors.start_date ? 'is-invalid' : ''}`}
                  style={{ fontSize: '1.04rem', padding: '0.64rem 0.8rem', height: 'auto', width: '100%', maxWidth: '200px' }}
                  value={formatDateForInput(formData.start_date)}
                  onChange={(e) => handleDateChange('start_date', e.target.value)}
                  aria-describedby={validationErrors.start_date ? 'start_date-error start_date-help' : 'start_date-help'}
                  aria-invalid={validationErrors.start_date ? 'true' : 'false'}
                />
                {validationErrors.start_date && (
                  <div id="start_date-error" className="fw-semibold validation-error" role="alert" style={{ fontSize: '0.875rem', display: 'block' }}>{validationErrors.start_date}</div>
                )}
              </div>
            </div>
            <div className="col-md-6">
              <div className="form-group mb-3" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                <label htmlFor="end_date" className="form-label mb-2" style={{ fontSize: '1rem', fontWeight: '600', minHeight: '1.5rem', lineHeight: '1.5' }}>
                  End Date
                </label>
                <div id="end_date-help" className="form-text mb-2" style={{ fontSize: '0.875rem', minHeight: '1.5rem', lineHeight: '1.4' }}>
                  When the study closes (shows countdown on card)
                </div>
                <input
                  type="date"
                  id="end_date"
                  className={`form-control ${validationErrors.end_date ? 'is-invalid' : ''}`}
                  style={{ fontSize: '1.04rem', padding: '0.64rem 0.8rem', height: 'auto', width: '100%', maxWidth: '200px' }}
                  value={formatDateForInput(formData.end_date)}
                  onChange={(e) => handleDateChange('end_date', e.target.value)}
                  aria-describedby={validationErrors.end_date ? 'end_date-error end_date-help' : 'end_date-help'}
                  aria-invalid={validationErrors.end_date ? 'true' : 'false'}
                />
                {validationErrors.end_date && (
                  <div id="end_date-error" className="fw-semibold validation-error" role="alert" style={{ fontSize: '0.875rem', display: 'block' }}>{validationErrors.end_date}</div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default BasicInfoTab;
