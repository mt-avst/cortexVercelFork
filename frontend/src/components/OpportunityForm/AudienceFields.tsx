import React from 'react';
import { OpportunityFormData } from '../../api/types';
import FieldError from './FieldError';
import TargetRolesInput from './TargetRolesInput';

/** Form field value type for opportunity form handlers */
type FormFieldValue = string | number | boolean | undefined;

interface AudienceFieldsProps {
  formData: OpportunityFormData;
  validationErrors: Record<string, string>;
  handleInputChange: (field: string, value: FormFieldValue) => void;
  handleBlur?: (field: string) => void;
  /** Roles/skills wanted is an array, so it takes its own setter (not the scalar handler). */
  onTargetRolesChange: (roles: string[]) => void;
}

/**
 * Date-only fields (study period): avoid timezone shifts.
 * Parsing "YYYY-MM-DD" as local midnight then calling toISOString() shifts the
 * calendar day for timezones ahead of UTC (e.g. APAC), so the picker appears to
 * reject "future" dates. We store the chosen calendar day as noon UTC; display
 * uses UTC Y/M/D.
 */
export const formatDateForInput = (isoString: string | undefined): string => {
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

/**
 * Parse YYYY-MM-DD from <input type="date"> as that calendar day at noon UTC
 * (stable round-trip).
 *
 * A native date input fires onChange on every keystroke of the year segment,
 * not just once a complete year is typed. While the year is only partly typed -
 * with month and day already valid - it reports a short, zero-padded year
 * embedded in an otherwise-complete date string (typing just the "6" of "2026"
 * reports "0006-06-15"). `Date.UTC`/`new Date()` then apply JavaScript's legacy
 * two-digit-year rule (any year 0-99 silently gets 1900 added), so that one
 * keystroke becomes 1906 instead of being recognised as unfinished (#110).
 * Requiring a plausible four-digit year rejects every one of those transient
 * values outright, so a mid-edit keystroke never reaches the caller.
 */
export const formatDateToISO = (dateValue: string): string | undefined => {
  if (!dateValue) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) return undefined;
  const parts = dateValue.split('-').map((p) => parseInt(p, 10));
  const [year, month, day] = parts;
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const ms = Date.UTC(year, month - 1, day, 12, 0, 0);
  const date = new Date(ms);
  if (isNaN(date.getTime())) return undefined;
  return date.toISOString();
};

/**
 * The audience block on the Screener step (D6): who the study is for.
 *
 * Participant Type, Roles or skills wanted and the Study Period recruitment
 * window are all decisions about the AUDIENCE, so they sit with the eligibility
 * gate rather than under "Content & Details" (petra-flow-structure 6). The
 * screener gate follows below, in `ScreenerStep`.
 *
 * The Study Period date fields are external-delivery only, unchanged from where
 * they used to live on Basic Information.
 */
const AudienceFields: React.FC<AudienceFieldsProps> = ({
  formData,
  validationErrors,
  handleInputChange,
  handleBlur,
  onTargetRolesChange
}) => {
  // The Study Period recruitment window is only meaningful for the link-based
  // types (poll, survey, question, unmoderated); the moderated types book slots
  // instead. Kept exactly as it was on Basic Information before D6.
  const isExternalLinkType = ['poll', 'survey', 'question', 'unmoderated'].includes(
    formData.type
  );

  // An explicit clear (value === '') always propagates, setting the field to
  // undefined. Anything else that fails to parse is a mid-edit keystroke, not
  // a deliberate clear, so it is ignored - the previous value in formData stays
  // put rather than being overwritten with `undefined`.
  const handleDateChange = (field: 'start_date' | 'end_date', value: string) => {
    if (value === '') {
      handleInputChange(field, undefined);
      return;
    }
    const iso = formatDateToISO(value);
    if (iso === undefined) return;
    handleInputChange(field, iso);
  };

  return (
    <div className="form-section mb-5">
      <div className="d-flex align-items-center mb-4 pb-3" style={{ borderBottom: 'none' }}>
        <div>
          <h2 className="h4 mb-1 section-title" style={{ fontSize: '1.5rem', lineHeight: '1.3', fontWeight: '600' }}>
            Audience
          </h2>
          <p className="mb-0 section-description" style={{ fontSize: '0.95rem' }}>
            Who can take part, and when
          </p>
        </div>
      </div>

      <div className="row">
        <div className="col-6">
          <div className="form-group mb-3">
            <label htmlFor="participant_type_required" className="form-label mb-2" style={{ fontSize: '1rem', fontWeight: '600' }}>
              Participant Type
            </label>
            <div className="form-text mb-2" style={{ fontSize: '0.875rem' }}>
              Who can participate in this study
            </div>
            <select
              id="participant_type_required"
              className={`form-select ${validationErrors.participant_type_required ? 'is-invalid' : ''}`}
              style={{ fontSize: '1.04rem', padding: '0.64rem 0.8rem', height: 'auto' }}
              value={formData.participant_type_required}
              onChange={(e) => handleInputChange('participant_type_required', e.target.value)}
              onBlur={() => handleBlur?.('participant_type_required')}
            >
              <option value="any" style={{ fontSize: '1.04rem', padding: '0.4rem' }}>Anyone</option>
              <option value="internal" style={{ fontSize: '1.04rem', padding: '0.4rem' }}>Internal employees only</option>
              {formData.type !== 'unmoderated' && (
                <option value="external" style={{ fontSize: '1.04rem', padding: '0.4rem' }}>External users only</option>
              )}
              <option value="specific" style={{ fontSize: '1.04rem', padding: '0.4rem' }}>Specific criteria</option>
            </select>
            {validationErrors.participant_type_required && (
              <FieldError>{validationErrors.participant_type_required}</FieldError>
            )}
            {formData.type === 'unmoderated' && (
              <div className="form-text mt-1" style={{ fontSize: '0.875rem' }}>
                Unmoderated studies run with logged-in Cortex users only.
              </div>
            )}
          </div>
        </div>

        <div className="col-6">
          {formData.participant_type_required === 'specific' && (
            <div className="form-group mb-3">
              <label htmlFor="participant_type_specific_details" className="form-label mb-2" style={{ fontSize: '1rem', fontWeight: '600' }}>
                Specific Criteria *
              </label>
              <div className="form-text mb-2" style={{ fontSize: '0.875rem' }}>
                Describe the specific participant requirements
              </div>
              <input
                type="text"
                id="participant_type_specific_details"
                className={`form-control ${validationErrors.participant_type_specific_details ? 'is-invalid' : ''}`}
                style={{ fontSize: '1.04rem', padding: '0.64rem 0.8rem', height: 'auto' }}
                value={formData.participant_type_specific_details}
                onChange={(e) => handleInputChange('participant_type_specific_details', e.target.value)}
                onBlur={() => handleBlur?.('participant_type_specific_details')}
                placeholder="e.g., Users with admin access, Mobile users, etc."
                required={formData.participant_type_required === 'specific'}
              />
              {validationErrors.participant_type_specific_details && (
                <FieldError>{validationErrors.participant_type_specific_details}</FieldError>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="row">
        <div className="col-12">
          <TargetRolesInput
            value={formData.target_roles ?? []}
            onChange={onTargetRolesChange}
          />
        </div>
      </div>

      {/* Study Period - only for external link types (poll, survey, question, unmoderated) */}
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
                <FieldError id="start_date-error">{validationErrors.start_date}</FieldError>
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
                <FieldError id="end_date-error">{validationErrors.end_date}</FieldError>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AudienceFields;
