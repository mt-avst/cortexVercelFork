import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import { listening } from '../../__tests__/helpers/listening';
import express from 'express';

// #14: route suites use the session-trusting auth double (see middleware/__mocks__/authenticate.ts);
// the real gate now re-reads the DB role, which their positional pool mock cannot satisfy.
jest.mock('../../middleware/authenticate');
jest.mock('../../config', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

import feedbackRouter from '../feedback';
import { pool } from '../../config';
import { errorHandler } from '../../utils/errorHandler';

const mockQuery = pool.query as unknown as jest.Mock;

/**
 * READING FEEDBACK IS OPEN TO EVERY ADMIN, DELIBERATELY. cto/AdaptaLabs#15.
 *
 * This looked like a defect and is not, which is why it now has a test rather
 * than a fix. `DELETE` on the same resource is `requireSuperadmin` while the
 * two reads are `requireAdmin`, and `frontend/src/api/client.ts` said in as
 * many words `Get all feedback (superadmin only)`. Both point at tightening.
 *
 * The intent is stated where the feature lives. `frontend/src/pages/Admin.tsx`
 * says it in terms, at the tab itself:
 *
 *     {(the) Feedback tab - all admins (researcher_admin and superadmin)}
 *
 * So `requireAdmin` matches a decision, and tightening to superadmin would
 * have removed a tab researcher_admins are explicitly meant to see. CHECKING
 * IS WHAT CHANGED THE ANSWER: the asymmetry with DELETE reads as a defect and
 * is a different decision - deleting someone's feedback is destructive and
 * irreversible, reading it is neither.
 *
 * The stale client comment that pointed the wrong way is fixed in this change.
 *
 * WHAT THIS TEST IS FOR: so that the next reader who spots the same asymmetry
 * finds a named decision instead of repeating the investigation, and so that
 * tightening it is a deliberate act that turns a test red rather than a tidy-up.
 */
type Role = 'employee' | 'researcher_admin' | 'superadmin';

const appAs = (role: Role | null) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = role
      ? { user: { id: 'u1', name: 'A', email: 'a@example.com', role } }
      : {};
    next();
  });
  app.use('/api/feedback', feedbackRouter);
  app.use(errorHandler);
  return app;
};

describe('feedback reads are open to every admin', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never);
  });

  it('lets a researcher_admin list feedback', async () => {
    await request(listening(appAs('researcher_admin'))).get('/api/feedback').expect(200);

    expect(mockQuery).toHaveBeenCalled();
  });

  it('lets a researcher_admin export feedback', async () => {
    await request(listening(appAs('researcher_admin'))).get('/api/feedback/export').expect(200);

    expect(mockQuery).toHaveBeenCalled();
  });

  it('lets a superadmin do both as well', async () => {
    await request(listening(appAs('superadmin'))).get('/api/feedback').expect(200);
    await request(listening(appAs('superadmin'))).get('/api/feedback/export').expect(200);
  });

  // THE CONTROL. Without these, a router that let EVERYONE through would
  // satisfy both assertions above, and this file would be recording a decision
  // nobody made.
  it('still refuses a non-admin', async () => {
    await request(listening(appAs('employee'))).get('/api/feedback').expect(403);
    await request(listening(appAs('employee'))).get('/api/feedback/export').expect(403);
  });

  it('still refuses an unauthenticated caller', async () => {
    await request(listening(appAs(null))).get('/api/feedback').expect(401);
    await request(listening(appAs(null))).get('/api/feedback/export').expect(401);
  });
});

describe('deleting feedback stays superadmin-only', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockQuery.mockResolvedValue({ rows: [{ id: 'f1' }], rowCount: 1 } as never);
  });

  // The asymmetry itself, pinned in BOTH directions. Pinning only the reads
  // would let a later "make this consistent" change resolve it by opening
  // DELETE, which is the destructive half and the one nobody argued for.
  it('refuses a researcher_admin, and deletes nothing', async () => {
    await request(listening(appAs('researcher_admin'))).delete('/api/feedback/f1').expect(403);

    expect(mockQuery).not.toHaveBeenCalled();
  });

  // The control for the absence-assertion above.
  it('lets a superadmin delete', async () => {
    await request(listening(appAs('superadmin'))).delete('/api/feedback/f1').expect(200);

    expect(mockQuery).toHaveBeenCalled();
  });
});
