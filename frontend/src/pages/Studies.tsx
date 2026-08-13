import React, { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';

import { useAuth } from '../contexts/AuthContext';
import { getFirstHandStudies } from '../api/client';
import { Alert, Card, CardBody } from '../components/ui';
import type { FirstHandStudy } from '../api/types';

/**
 * Study index for `/admin/studies`. Lists the recorded-study definitions a
 * researcher can author and edit. Ported from FirstHand's studies index and
 * admin-gated via AuthContext (the backend studies CRUD is `requireAdmin`).
 */
const Studies: React.FC = () => {
  const { user, loading } = useAuth();
  const [studies, setStudies] = useState<FirstHandStudy[]>([]);
  const [loadingStudies, setLoadingStudies] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isAdmin =
    user?.role === 'researcher_admin' || user?.role === 'superadmin';

  useEffect(() => {
    if (loading || !isAdmin) {
      return;
    }

    let cancelled = false;
    setLoadingStudies(true);
    setError(null);

    getFirstHandStudies()
      .then((result) => {
        if (!cancelled) setStudies(result);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load studies.');
      })
      .finally(() => {
        if (!cancelled) setLoadingStudies(false);
      });

    return () => {
      cancelled = true;
    };
  }, [loading, isAdmin]);

  if (loading) {
    return (
      <div className="d-flex justify-content-center py-5">
        <div className="spinner-border text-primary" role="status" aria-label="Loading">
          <span className="visually-hidden">Loading...</span>
        </div>
      </div>
    );
  }

  if (!loading && !user) {
    return <Navigate to="/auth/login" replace />;
  }

  if (!loading && user && !isAdmin) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="py-4">
      <Link className="btn btn-link px-0 mb-3" to="/admin">
        Back to admin
      </Link>

      <div className="d-flex justify-content-between align-items-start flex-wrap gap-3 mb-3">
        <div>
          <p className="text-uppercase fw-semibold text-muted mb-1">
            Researcher workspace
          </p>
          <h1 className="h3 mb-2">Studies</h1>
          <p className="text-muted mb-0">
            Studies define the prompt sequence, consent copy, and recording
            context participants experience. An unmoderated opportunity
            references a study by id.
          </p>
        </div>
        <Link className="btn btn-primary" to="/admin/studies/new">
          New study
        </Link>
      </div>

      {error ? (
        <Alert variant="danger" className="mb-4">
          {error}
        </Alert>
      ) : null}

      {loadingStudies ? (
        <div className="d-flex justify-content-center py-5">
          <div
            className="spinner-border text-primary"
            role="status"
            aria-label="Loading studies"
          >
            <span className="visually-hidden">Loading studies...</span>
          </div>
        </div>
      ) : studies.length === 0 ? (
        <p className="text-muted">
          No studies yet. Create the first one to get started.
        </p>
      ) : (
        <ul className="list-unstyled">
          {studies.map((study) => (
            <li className="mb-3" key={study.id}>
              <Card padding="md" hoverable={false}>
                <CardBody>
                  <p className="text-uppercase fw-semibold text-muted mb-1">
                    {study.status ?? 'draft'}
                  </p>
                  <strong className="d-block mb-1">{study.title}</strong>
                  <p className="mb-2">{study.intro_text}</p>
                  {study.updated_at ? (
                    <p className="text-muted small mb-3">
                      Updated {new Date(study.updated_at).toLocaleString()}
                    </p>
                  ) : null}
                  <Link
                    className="btn btn-outline-primary btn-sm"
                    to={`/admin/studies/${encodeURIComponent(study.id)}/edit`}
                  >
                    Edit
                  </Link>
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default Studies;
