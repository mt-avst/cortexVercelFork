import React from 'react';
import { QUESTION_CARRYING_TYPES } from '@shared/firsthand/delivery';
import { OpportunityFormData } from '../../api/types';
import FieldError from './FieldError';

/** Form field value type for opportunity form handlers */
type FormFieldValue = string | number | boolean | undefined;

interface BasicInfoTabProps {
  formData: OpportunityFormData;
  validationErrors: Record<string, string>;
  handleInputChange: (field: string, value: FormFieldValue) => void;
  handleBlur?: (field: string) => void;
}

/**
 * The one-line gloss under the study-type select, or '' when no type is chosen.
 *
 * Returned as a string so the caller can render the help slot only when there is
 * something to say - the slot used to reserve a fixed ~2.5rem height holding a
 * single space, an empty grey gap above the select before a type was picked
 * (Lane C "Then"). The "question sessions" line here was already corrected in
 * #78: a `question` has no Session Management step and books nothing.
 */
const typeHintFor = (type: string, deliveryMode: string): string => {
  if (type === 'test' || type === 'interview') {
    return 'Creates bookable time slots for interactive sessions';
  }
  if (type === 'question') {
    return deliveryMode === 'native'
      ? 'One question, answered in Cortex'
      : 'Opens an external tool for a single question';
  }
  if (type === 'poll') {
    return deliveryMode === 'native'
      ? 'Quick responses, answered in Cortex'
      : 'Opens an external poll tool for quick responses';
  }
  if (type === 'survey') {
    return deliveryMode === 'native'
      ? 'Detailed feedback, answered in Cortex'
      : 'Opens an external survey tool for detailed feedback';
  }
  if (type === 'unmoderated') {
    return 'Self-guided, recorded in the browser';
  }
  return '';
};

const BasicInfoTab: React.FC<BasicInfoTabProps> = ({
  formData,
  validationErrors,
  handleInputChange,
  handleBlur
}) => {
  const typeHint = typeHintFor(formData.type, formData.delivery_mode ?? 'external');
  return (
    <div className="tab-pane active">
      <div className="form-section mb-5">
        <div className="d-flex align-items-center mb-4 pb-3" style={{ borderBottom: 'none' }}>
          <div>
            <h2 className="h4 mb-1 section-title" style={{ fontSize: '1.5rem', lineHeight: '1.3', fontWeight: '600' }}>
              Basic Information
            </h2>
            <p className="mb-0 section-description" style={{ fontSize: '0.95rem' }}>
              Configure the study type and basic details
            </p>
          </div>
        </div>

        <div className="row g-3" style={{ alignItems: 'flex-start' }}>
          <div className="col-md-12">
            <div className="form-group mb-3" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              <label htmlFor="type" className="form-label mb-2" style={{ fontSize: '1rem', fontWeight: '600', minHeight: '1.5rem', lineHeight: '1.5' }}>
                Research Study Type *
              </label>
              {/* Rendered only when a type is chosen (Lane C "Then"): before
                  then this reserved a fixed ~2.5rem help slot holding a single
                  space, an empty grey gap above the select. */}
              {typeHint && (
                <div id="type-help" className="form-text mb-2" style={{ fontSize: '0.875rem', lineHeight: '1.4' }}>
                  {typeHint}
                </div>
              )}
              <select
                id="type"
                className={`form-select ${validationErrors.type ? 'is-invalid' : ''}`}
                style={{ fontSize: '1.04rem', padding: '0.64rem 0.8rem', height: 'auto', width: '100%' }}
                value={formData.type}
                onChange={(e) => handleInputChange('type', e.target.value)}
                onBlur={() => handleBlur?.('type')}
                aria-describedby={
                  [
                    validationErrors.type ? 'type-error' : null,
                    typeHint ? 'type-help' : null
                  ]
                    .filter(Boolean)
                    .join(' ') || undefined
                }
                aria-invalid={validationErrors.type ? 'true' : 'false'}
                aria-required="true"
                required
              >
                <option value="" disabled>Please select research study type</option>
                <option value="interview" style={{ fontSize: '1.04rem', padding: '0.4rem' }}>Interview - Research interview session</option>
                {/* The gloss after the dash may say anything useful; the NAME
                    must be the one every other surface uses. This form used to
                    say "User Test" and "Unmoderated Testing" while the dashboard
                    badged them "APP TESTING" and "UNMODERATED" and browse called
                    them "Usability test" and "Recorded study" - three names for
                    one thing, so a researcher and a participant could not talk
                    about the same study without translating. */}
                <option value="poll" style={{ fontSize: '1.04rem', padding: '0.4rem' }}>Quick poll - Quick opinion gathering</option>
                <option value="question" style={{ fontSize: '1.04rem', padding: '0.4rem' }}>One question - Single question session</option>
                <option value="survey" style={{ fontSize: '1.04rem', padding: '0.4rem' }}>Survey - Detailed feedback collection</option>
                <option value="test" style={{ fontSize: '1.04rem', padding: '0.4rem' }}>Live session - Usability test you moderate, at a booked time</option>
                <option value="unmoderated" style={{ fontSize: '1.04rem', padding: '0.4rem' }}>Recorded session - Usability test the participant runs alone, recorded in the browser</option>
              </select>
                {validationErrors.type && (
                <FieldError id="type-error">{validationErrors.type}</FieldError>
              )}
            </div>
          </div>

          {/*
            Where the participant answers. Only the question-carrying types
            have the choice - a recorded study has nowhere external to go, and
            the bookable types have no link at all.

            A radio pair rather than a checkbox: neither option is the
            "unticked" state of the other, and "external" is a real, supported
            choice for a team that already licenses SurveyMonkey rather than a
            fallback. External stays the default so an author who never looks at
            this gets exactly today's behaviour.
          */}
          {QUESTION_CARRYING_TYPES.has(formData.type) && (
            <div className="row mb-4">
              <div className="col-12">
                <fieldset>
                  <legend className="form-label mb-2" style={{ fontSize: '1rem', fontWeight: '600' }}>
                    Where participants answer
                  </legend>
                  <div className="form-check">
                    <input
                      className="form-check-input"
                      type="radio"
                      name="delivery_mode"
                      id="delivery_mode_external"
                      value="external"
                      checked={(formData.delivery_mode ?? 'external') === 'external'}
                      onChange={() => handleInputChange('delivery_mode', 'external')}
                    />
                    <label className="form-check-label" htmlFor="delivery_mode_external">
                      In an external tool
                      <span className="form-text d-block">
                        You give Cortex the link. SurveyMonkey, Google Forms,
                        Typeform and the rest - Cortex sends people there and
                        counts the clicks, and the answers live in that tool.
                      </span>
                    </label>
                  </div>
                  <div className="form-check mt-2">
                    <input
                      className="form-check-input"
                      type="radio"
                      name="delivery_mode"
                      id="delivery_mode_native"
                      value="native"
                      checked={formData.delivery_mode === 'native'}
                      onChange={() => handleInputChange('delivery_mode', 'native')}
                    />
                    <label className="form-check-label" htmlFor="delivery_mode_native">
                      In Cortex
                      <span className="form-text d-block">
                        You write the questions here and the answers come back
                        in Cortex. Nothing is recorded - no screen, no
                        microphone, no camera.
                      </span>
                    </label>
                  </div>
                </fieldset>
              </div>
            </div>
          )}
        </div>

        <div className="row g-3" style={{ alignItems: 'flex-start' }}>
          <div className="col-md-12">
            <div className="form-group mb-3" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              <label htmlFor="title" className="form-label mb-2" style={{ fontSize: '1rem', fontWeight: '600', minHeight: '1.5rem', lineHeight: '1.5' }}>
                Title *
              </label>
              <div id="title-help" className="form-text mb-2" style={{ fontSize: '0.875rem', minHeight: '2.5rem', lineHeight: '1.4' }}>
                Clear, concise title that describes the study (4-140 characters)
              </div>
              <input
                type="text"
                id="title"
                className={`form-control ${validationErrors.title ? 'is-invalid' : ''}`}
                style={{ fontSize: '1.04rem', padding: '0.64rem 0.8rem', height: 'auto', width: '100%' }}
                value={formData.title}
                onChange={(e) => handleInputChange('title', e.target.value)}
                onBlur={() => handleBlur?.('title')}
                placeholder="e.g., User Interface Testing Session"
                aria-describedby={validationErrors.title ? 'title-error title-help' : 'title-help'}
                aria-invalid={validationErrors.title ? 'true' : 'false'}
                aria-required="true"
                required
              />
              {validationErrors.title && (
                <FieldError id="title-error">{validationErrors.title}</FieldError>
              )}
            </div>
          </div>
        </div>

        <div className="row g-3" style={{ alignItems: 'flex-start' }}>
          <div className="col-md-12">
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
                onBlur={() => handleBlur?.('purpose_one_liner')}
                placeholder="e.g., Help us test the new dashboard interface to improve user experience"
                aria-describedby={validationErrors.purpose_one_liner ? 'purpose-error purpose-help' : 'purpose-help'}
                aria-invalid={validationErrors.purpose_one_liner ? 'true' : 'false'}
                aria-required="true"
                required
              />
              {validationErrors.purpose_one_liner && (
                <FieldError id="purpose-error">{validationErrors.purpose_one_liner}</FieldError>
              )}
            </div>
          </div>
        </div>

        {/* Description and Product are advert copy: what the study is and how it
            is pitched, so they sit with Title and Purpose (D6). */}
        <div className="row">
          <div className="col-md-6 col-12">
            <div className="form-group mb-3">
              <label htmlFor="description_optional" className="form-label mb-2" style={{ fontSize: '1rem', fontWeight: '600' }}>
                Description (Optional)
              </label>
              <div className="form-text mb-2" style={{ fontSize: '0.875rem' }}>
                Detailed description of what participants will do and what to expect
              </div>
              <textarea
                id="description_optional"
                className={`form-control ${validationErrors.description_optional ? 'is-invalid' : ''}`}
                style={{ fontSize: '1.04rem', padding: '0.64rem 0.8rem', height: '120px', resize: 'vertical' }}
                value={formData.description_optional}
                onChange={(e) => handleInputChange('description_optional', e.target.value)}
                placeholder="Provide detailed information about the study, what participants will be doing, what they need to prepare, etc."
              />
              {validationErrors.description_optional && (
                <FieldError>{validationErrors.description_optional}</FieldError>
              )}
            </div>
          </div>
        </div>

        <div className="row">
          <div className="col-md-6 col-12">
            <div className="form-group mb-3">
              <label htmlFor="product_optional" className="form-label mb-2" style={{ fontSize: '1rem', fontWeight: '600' }}>
                Product/Feature (Optional)
              </label>
              <div className="form-text mb-2" style={{ fontSize: '0.875rem' }}>
                Specific product, feature, or area this study relates to
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
                <FieldError>{validationErrors.product_optional}</FieldError>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default BasicInfoTab;
