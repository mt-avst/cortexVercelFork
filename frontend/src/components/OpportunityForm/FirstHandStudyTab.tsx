import React, { useEffect, useState } from 'react';

import { getFirstHandStudies } from '../../api/client';
import { FirstHandStudy, OpportunityFormData } from '../../api/types';

type FormFieldValue = string | number | boolean | undefined;

interface FirstHandStudyTabProps {
  formData: OpportunityFormData & { firsthand_study_id?: string };
  validationErrors: Record<string, string>;
  handleInputChange: (field: string, value: FormFieldValue) => void;
}

const FirstHandStudyTab: React.FC<FirstHandStudyTabProps> = ({
  formData,
  validationErrors,
  handleInputChange,
}) => {
  const [studies, setStudies] = useState<FirstHandStudy[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState('');
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFetchError('');
    getFirstHandStudies()
      .then((data) => {
        if (!cancelled) setStudies(data);
      })
      .catch(() => {
        if (!cancelled) setFetchError('Could not load studies.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [retryCount]);

  const launchedStudies = studies.filter((s) => s.status === 'launched');

  return (
    <div className="tab-pane active">
      <div className="form-section mb-5">
        <div className="d-flex align-items-center mb-4 pb-3" style={{ borderBottom: 'none' }}>
          <div>
            <h2 className="h4 mb-1 section-title" style={{ fontSize: '1.5rem', lineHeight: '1.3', fontWeight: '600' }}>
              Recorded Study
            </h2>
            <p className="mb-0 section-description" style={{ fontSize: '0.95rem' }}>
              Link a recorded study - participants will be routed directly into it
            </p>
          </div>
        </div>

        <div className="row">
          <div className="col-12 col-md-8">
            <div className="form-group mb-4">
              <label htmlFor="firsthand_study_id" className="form-label mb-2" style={{ fontSize: '1rem', fontWeight: '600' }}>
                Recorded Study *
              </label>

              {loading && (
                <div className="text-muted" style={{ fontSize: '0.875rem' }}>
                  <span className="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true" />
                  Loading studies...
                </div>
              )}

              {!loading && fetchError && (
                <div className="alert alert-warning py-2 d-flex align-items-center justify-content-between" style={{ fontSize: '0.875rem' }}>
                  <span>{fetchError}</span>
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-warning ms-3"
                    onClick={() => setRetryCount((n) => n + 1)}
                  >
                    Retry
                  </button>
                </div>
              )}

              {!loading && !fetchError && (
                <select
                  id="firsthand_study_id"
                  className={`form-select ${validationErrors.firsthand_study_id ? 'is-invalid' : ''}`}
                  style={{ fontSize: '1.04rem', padding: '0.64rem 0.8rem', height: 'auto' }}
                  value={formData.firsthand_study_id || ''}
                  onChange={(e) => handleInputChange('firsthand_study_id', e.target.value || undefined)}
                >
                  <option value="">-- Select a launched study --</option>
                  {launchedStudies.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title}
                      {s.estimated_duration_minutes ? ` (${s.estimated_duration_minutes} min)` : ''}
                    </option>
                  ))}
                  {launchedStudies.length === 0 && (
                    <option disabled value="">No launched studies available</option>
                  )}
                </select>
              )}

              {validationErrors.firsthand_study_id && (
                <div className="fw-semibold" style={{ fontSize: '0.875rem', display: 'block' }}>
                  {validationErrors.firsthand_study_id}
                </div>
              )}

              {formData.firsthand_study_id ? (
                <div className="form-text mt-1" style={{ fontSize: '0.875rem', color: 'var(--bs-success)' }}>
                  Participants will be sent directly into this study via a generated session URL.
                </div>
              ) : (
                <div className="form-text mt-1" style={{ fontSize: '0.875rem' }}>
                  An unmoderated opportunity is powered by a recorded study. Only launched studies appear here.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default FirstHandStudyTab;
