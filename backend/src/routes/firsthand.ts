import { Router, Request, Response } from 'express';

import { pool } from '../config';
import { requireAdmin, requireSuperadmin } from '../middleware/authenticate';
import { asyncHandler } from '../utils/errorHandler';
import {
  createStudy,
  deleteStudy,
  getStudyById,
  isStudiesPersistenceConfigured,
  listStudies,
  updateStudy
} from '../firsthand/studies-repository';
import {
  createStudyRequestSchema,
  updateStudyRequestSchema
} from '../../../shared/firsthand/study-input';

const router: Router = Router();

// ─── Studies CRUD (B3a) ──────────────────────────────────────────────────────
// In-process studies persistence, replacing the FirstHand HMAC proxy. Gated on
// Cortex requireAdmin (H4): FirstHand's reviewer OIDC (reviewer-auth-server /
// reviewer-auth / reviewer-oidc / requireStaffPageSession) is intentionally NOT
// ported — the Cortex backend is the single Okta owner and admins are the sole
// study authors.

// Mirrors FirstHand's requireStaff persistence guard: fail loud with 503 when
// no runtime database is configured so a misconfig never silently no-ops.
function ensureStudiesPersistence(res: Response): boolean {
  if (!isStudiesPersistenceConfigured()) {
    res.status(503).json({
      error: 'persistence_not_configured',
      message: 'Studies require a configured PostgreSQL database.'
    });
    return false;
  }
  return true;
}

// GET /api/firsthand/migration-report - latest Phase C data-migration report
// as text/plain, written by scripts/firsthand-data-migrate.mjs (the chart Job)
// into public.firsthand_migration_reports. Exists because job pod logs are not
// reachable without cluster access. Superadmin-only; TEMPORARY - remove with
// the rest of the Phase-C migration machinery.
router.get('/migration-report', requireSuperadmin, asyncHandler(async (_req: Request, res: Response) => {
  const result = await pool.query(
    'SELECT ran_at, mode, success, report FROM firsthand_migration_reports ORDER BY ran_at DESC LIMIT 1'
  );
  if (result.rows.length === 0) {
    return res.status(404).type('text/plain').send(
      'No migration report yet. Either the job has not run since this table landed, or it failed before connecting to the databases (check the ArgoCD sync status).'
    );
  }
  const row = result.rows[0];
  res.type('text/plain').send(
    `ran_at: ${row.ran_at.toISOString()}\nmode: ${row.mode}\nsuccess: ${row.success}\n\n${row.report}\n`
  );
}));

// GET /api/firsthand/studies - list studies for the Cortex study picker
router.get('/studies', requireAdmin, asyncHandler(async (_req: Request, res: Response) => {
  // listStudies() returns [] when persistence is unconfigured, matching the
  // FirstHand list endpoint's soft-empty behaviour.
  const studies = await listStudies();
  res.json({ studies });
}));

// POST /api/firsthand/studies - create a study
router.post('/studies', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  if (!ensureStudiesPersistence(res)) return;

  const parsed = createStudyRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_payload', details: parsed.error.flatten() });
  }

  try {
    const stored = await createStudy(parsed.data);
    return res.status(201).json({ study: stored.study, steps: stored.steps });
  } catch (error) {
    return res.status(400).json({
      error: 'create_failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}));

// GET /api/firsthand/studies/:studyId - fetch a single study with its steps
router.get('/studies/:studyId', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  if (!ensureStudiesPersistence(res)) return;

  const stored = await getStudyById(req.params.studyId);
  if (!stored) {
    return res.status(404).json({ error: 'not_found' });
  }

  return res.json({ study: stored.study, steps: stored.steps });
}));

// PUT /api/firsthand/studies/:studyId - update a study
router.put('/studies/:studyId', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  if (!ensureStudiesPersistence(res)) return;

  const parsed = updateStudyRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_payload', details: parsed.error.flatten() });
  }

  try {
    const updated = await updateStudy(req.params.studyId, parsed.data);
    if (!updated) {
      return res.status(404).json({ error: 'not_found' });
    }
    return res.json({ study: updated.study, steps: updated.steps });
  } catch (error) {
    return res.status(400).json({
      error: 'update_failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}));

// DELETE /api/firsthand/studies/:studyId - delete a study
router.delete('/studies/:studyId', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  if (!ensureStudiesPersistence(res)) return;

  const removed = await deleteStudy(req.params.studyId);
  if (!removed) {
    return res.status(404).json({ error: 'not_found' });
  }

  return res.json({ ok: true });
}));

// The HMAC callback receiver (POST /api/firsthand/callbacks) is gone: the merge
// deletes the cross-app hop. Internalised sessions write lifecycle events to
// opportunity_session_events in-process (see firsthand/completion-events.ts),
// so there is no second app to call back.

export default router;
