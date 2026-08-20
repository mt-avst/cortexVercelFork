import React from 'react';
import { OpportunityFormData } from '../../api/types';

/** Form field value type for opportunity form handlers */
type FormFieldValue = string | number | boolean | undefined;

interface ExternalLinkTabProps {
  formData: OpportunityFormData;
  validationErrors: Record<string, string>;
  handleInputChange: (field: string, value: FormFieldValue) => void;
  /**
   * Validate this field as the author leaves it.
   *
   * The page has had a `validateField` case for `external_link_optional` for a
   * long time and it never ran, because this tab was never given the handler -
   * so the rule was dead code that read as coverage. A mutation disabling its
   * scheme check left all 1210 tests green, which is how that was found.
   *
   * Wired rather than deleted because a scheme rule the author only hears about
   * at save time is the weaker half of this fix: the point is to say where the
   * problem is at the moment they make it.
   */
  handleBlur: (field: string, value: FormFieldValue) => void;
}

const ExternalLinkTab: React.FC<ExternalLinkTabProps> = ({
  formData,
  validationErrors,
  handleInputChange,
  handleBlur
}) => {
  return (
    <div className="tab-pane active">
      <div className="form-section mb-5">
        <div className="d-flex align-items-center mb-4 pb-3" style={{ borderBottom: 'none' }}>
          <div>
            <h2 className="h4 mb-1 section-title" style={{ fontSize: '1.5rem', lineHeight: '1.3', fontWeight: '600' }}>
              External Link
            </h2>
            <p className="mb-0 section-description" style={{ fontSize: '0.95rem' }}>
              Configure the external tool for polls, surveys, and questions
            </p>
          </div>
        </div>

        <div className="row">
          <div className="col-12">
            <div className="form-group mb-3">
              <label htmlFor="external_link_optional" className="form-label mb-2" style={{ fontSize: '1rem', fontWeight: '600' }}>
                External Link *
              </label>
              <div className="form-text mb-2" style={{ fontSize: '0.875rem' }}>
                URL to the external tool (Google Forms, SurveyMonkey, Maze, UserTesting, etc.)
              </div>
              <input
                type="url"
                id="external_link_optional"
                className={`form-control ${validationErrors.external_link_optional ? 'is-invalid' : ''}`}
                style={{ fontSize: '1.04rem', padding: '0.64rem 0.8rem', height: 'auto' }}
                value={formData.external_link_optional}
                onChange={(e) => handleInputChange('external_link_optional', e.target.value)}
                onBlur={(e) => handleBlur('external_link_optional', e.target.value)}
                placeholder="https://forms.google.com/your-form or https://maze.co/your-test"
              />
              {validationErrors.external_link_optional && (
                <div className="fw-semibold" style={{ fontSize: '0.875rem', display: 'block' }}>{validationErrors.external_link_optional}</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ExternalLinkTab;
