import React from 'react';
import { OpportunityFormData } from '../../api/types';
import FieldError from './FieldError';
import StudyTypePicker from './StudyTypePicker';
import type { DraftedOpportunity } from '../../api/client';

/** Form field value type for opportunity form handlers */
type FormFieldValue = string | number | boolean | undefined;

interface BasicInfoTabProps {
  formData: OpportunityFormData;
  validationErrors: Record<string, string>;
  handleInputChange: (field: string, value: FormFieldValue) => void;
  handleBlur?: (field: string) => void;
  /**
   * D13, W9: passed straight through to StudyTypePicker, which mounts the
   * live "Describe it" panel only when this is provided - see
   * OpportunityForm.tsx's own comment at the call site for why it is new-only.
   */
  onApplyDraft?: (draft: DraftedOpportunity) => void;
}

const BasicInfoTab: React.FC<BasicInfoTabProps> = ({
  formData,
  validationErrors,
  handleInputChange,
  handleBlur,
  onApplyDraft
}) => {
  return (
    <div className="tab-pane active">
      {/* The type choice (D2): one picker of nine cards, replacing the old
          "Research Study Type" select and the "Where participants answer"
          delivery radios. Selecting a card sets the existing type and
          delivery_mode values together, and the front-door AI prompt (D13)
          is wired by W9 - live only when onApplyDraft is provided. Row 7: a
          published study's type is read-only behind "Change study type". */}
      <StudyTypePicker
        type={formData.type}
        deliveryMode={formData.delivery_mode ?? 'external'}
        onSelect={(nextType, nextDelivery) => {
          handleInputChange('type', nextType);
          handleInputChange('delivery_mode', nextDelivery);
        }}
        isPublished={formData.status === 'published'}
        validationError={validationErrors.type}
        onApplyDraft={onApplyDraft}
      />

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
