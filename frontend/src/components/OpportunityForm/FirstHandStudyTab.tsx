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

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFetchError('');
    getFirstHandStudies()
      .then((data) => {
        if (!cancelled) setStudies(data);
      })
      .catch(() => {
        if (!cancelled) setFetchError('Could not load FirstHand studies. Check that FirstHand is running.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const launchedStudies = studies.filter((s) => s.study.status === 'launched');

  return (
    <div className="tab-pane active">
      <div className="form-section mb-5">
        <div className="d-flex align-items-center mb-4 pb-3" style={{ borderBottom: 'none' }}>
          <div>
            <h2 className="h4 mb-1 section-title" style={{ fontSize: '1.5rem', lineHeight: '1.3', fontWeight: '600' }}>
              FirstHand Study
            </h2>
            <p className="mb-0 section-description" style={{ fontSize: '0.95rem' }}>
              Link a FirstHand unmoderated study - participants will be routed directly into it
            </p>
          </div>
        </div>

        <div className="row">
          <div className="col-12 col-md-8">
            <div className="form-group mb-4">
              <label htmlFor="firsthand_study_id" className="form-label mb-2" style={{ fontSize: '1rem', fontWeight: '600' }}>
                FirstHand Study
              </label>

              {loading && (
                <div className="text-muted" style={{ fontSize: '0.875rem' }}>
                  <span className="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true" />
                  Loading studies...
                </div>
              )}

              {!loading && fetchError && (
                <div className="alert alert-warning py-2" style={{ fontSize: '0.875rem' }}>
                  {fetchError}
                </div>
              )}

              {!loading && !fetchError && (
                <select
                  id="firsthand_study_id"
                  className="form-select"
                  style={{ fontSize: '1.04rem', padding: '0.64rem 0.8rem', height: 'auto' }}
                  value={formData.firsthand_study_id || ''}
                  onChange={(e) => handleInputChange('firsthand_study_id', e.target.value || undefined)}
                >
                  <option value="">-- No FirstHand study (use external link below) --</option>
                  {launchedStudies.map((s) => (
                    <option key={s.study.id} value={s.study.id}>
                      {s.study.title}
                      {s.study.estimated_duration_minutes ? ` (${s.study.estimated_duration_minutes} min)` : ''}
                      {` — ${s.steps.length} step${s.steps.length !== 1 ? 's' : ''}`}
                    </option>
                  ))}
                  {launchedStudies.length === 0 && (
                    <option disabled value="">No launched studies available in FirstHand</option>
                  )}
                </select>
              )}

              {formData.firsthand_study_id && (
                <div className="form-text mt-1" style={{ fontSize: '0.875rem', color: 'var(--bs-success)' }}>
                  Participants will be sent directly into this study via a generated session URL.
                </div>
              )}
            </div>
          </div>
        </div>

        <hr className="my-4" />

        <div className="row">
          <div className="col-12">
            <div className="form-group mb-3">
              <label htmlFor="external_link_optional" className="form-label mb-2" style={{ fontSize: '1rem', fontWeight: '600' }}>
                External Link {formData.firsthand_study_id ? '(optional - overridden by FirstHand study above)' : '*'}
              </label>
              <div className="form-text mb-2" style={{ fontSize: '0.875rem' }}>
                Fallback URL if no FirstHand study is selected (e.g. Maze, UserTesting)
              </div>
              <input
                type="url"
                id="external_link_optional"
                className={`form-control ${validationErrors.external_link_optional ? 'is-invalid' : ''}`}
                style={{ fontSize: '1.04rem', padding: '0.64rem 0.8rem', height: 'auto' }}
                value={formData.external_link_optional || ''}
                onChange={(e) => handleInputChange('external_link_optional', e.target.value)}
                placeholder="https://maze.co/your-test"
                disabled={!!formData.firsthand_study_id}
              />
              {validationErrors.external_link_optional && (
                <div className="fw-semibold" style={{ fontSize: '0.875rem', display: 'block' }}>
                  {validationErrors.external_link_optional}
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
