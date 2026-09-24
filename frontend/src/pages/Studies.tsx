import React, { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';

import { useAuth } from '../contexts/AuthContext';
import { getFirstHandStudies } from '../api/client';
import ConsentStateChip from '../components/ConsentStateChip';
import { Alert, Card, CardBody, StatusBadge, type StatusType } from '../components/ui';
import { isStudyReadOnly } from '../utils/studyOwnership';
import { formatDateTime } from '../utils/datetime';
import { CREATE_AND_MANAGE } from '@shared/pageNames';
import type { FirstHandStudy } from '../api/types';

/**
 * The human label for a task list's stored status.
 *
 * The raw enum leaked onto the card: a `launched` study read "launched" here
 * while every participant-facing surface calls that state "Published". Mapped so
 * the index says the same word as the rest of the product; an unrecognised
 * status falls back to itself rather than vanishing.
 */
const STUDY_STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  launched: 'Published',
  archived: 'Archived'
};

/**
 * Row 35: a plain uppercase text label here, against `StatusBadge` - a pill -
 * everywhere the opportunity form shows a study's standing. `StatusType`
 * spells the same three states differently (`published`/`closed` rather than
 * `launched`/`archived`), hence the map rather than one shared enum.
 */
const STUDY_STATUS_BADGE: Record<string, StatusType> = {
  draft: 'draft',
  launched: 'published',
  archived: 'closed'
};

/**
 * Task list index for `/admin/studies`. Lists the task lists a researcher can
 * author and edit. The route keeps its `studies` path: renaming it would break
 * existing links, and this rename is copy only. Ported from FirstHand's studies index and
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
        if (!cancelled) setError('Could not load task lists.');
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
        Back to {CREATE_AND_MANAGE}
      </Link>

      {/*
        Row 35: this index had no page shell where every wizard screen sits
        inside a card - a bare page with the per-item Cards below as its only
        card. Wrapped here, matching StudyEditor.tsx's own fix for the same
        row.
      */}
      <Card padding="lg" hoverable={false}>
        <CardBody>
          <div className="d-flex justify-content-between align-items-start flex-wrap gap-3 mb-3">
            <div>
              <p className="text-uppercase fw-semibold text-muted mb-1">
                Researcher workspace
              </p>
              <h1 className="h3 mb-2">Task Lists</h1>
              <p className="text-muted mb-0">
                A task list defines the prompt sequence, consent copy and
                recording context participants experience. An unmoderated
                study references a task list by id.
              </p>
            </div>
            <Link className="btn btn-primary" to="/admin/studies/new">
              New Task List
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
                aria-label="Loading task lists"
              >
                <span className="visually-hidden">Loading task lists...</span>
              </div>
            </div>
          ) : studies.length === 0 ? (
            <p className="text-muted">
              No task lists yet. Create the first one to get started.
            </p>
          ) : (
            <ul className="list-unstyled">
              {studies.map((study) => {
                // Another researcher's study is still listed - reuse across
                // owners is deliberate - but offering "Edit" would walk the
                // user into a form that immediately tells them they cannot
                // save.
                const readOnly = isStudyReadOnly(study, user);
                const status = study.status ?? 'draft';

                return (
                  <li className="mb-3" key={study.id}>
                    <Card padding="md" hoverable={false}>
                      <CardBody>
                        <div className="d-flex align-items-center gap-2 mb-1">
                          {/*
                            Row 35: the plain uppercase text label became the
                            same StatusBadge pill the opportunity form uses -
                            not a hand-rolled shape of its own.
                          */}
                          <StatusBadge
                            status={STUDY_STATUS_BADGE[status] ?? 'draft'}
                          >
                            {STUDY_STATUS_LABEL[status] ?? status}
                          </StatusBadge>
                          <ConsentStateChip templateId={study.consent_template_id} />
                        </div>
                        <strong className="d-block mb-1">{study.title}</strong>
                        <p className="mb-2">{study.intro_text}</p>
                        {study.updated_at || readOnly ? (
                          <p className="text-muted small mb-3">
                            {study.updated_at
                              ? `Updated ${formatDateTime(study.updated_at) ?? ''}`
                              : null}
                            {study.updated_at && readOnly ? <br /> : null}
                            {readOnly ? 'Owned by another researcher' : null}
                          </p>
                        ) : null}
                        <Link
                          className="btn btn-outline-primary btn-sm"
                          to={`/admin/studies/${encodeURIComponent(study.id)}/edit`}
                        >
                          {readOnly ? 'View' : 'Edit'}
                        </Link>
                      </CardBody>
                    </Card>
                  </li>
                );
              })}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
};

export default Studies;
