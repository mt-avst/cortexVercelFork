import { describe, it, expect, jest } from '@jest/globals';
import request from 'supertest';
import express, { Request, Response } from 'express';

import {
  participantRuntimeWork,
  publicRuntimeWork
} from '../runtime-work-class';
import { currentRuntimeWorkClass } from '../../firsthand/runtime-pool-admission';

jest.mock('../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  redactSensitiveUrl: (url: string) => url
}));

/**
 * THE MIDDLEWARE'S BODY, ACTUALLY EXECUTED.
 *
 * Everything else that mentions `participantRuntimeWork` compares it by
 * IDENTITY - the route table asks whether this exact function object is
 * mounted, and in what position. Nothing called it. So replacing its whole body
 * with a bare `next()` left the route table green (still the same object, still
 * in the same place), the admission tests green (they call
 * `runAsParticipantWork` directly), and the starvation tests green (they wrap
 * the seam themselves) - while every participant route silently fell back to
 * the admin default and the entire change became a no-op. Found by the review
 * gate, not by a matrix of thirty mutations that never mutated this file.
 *
 * The lesson is narrower than "test your middleware": a test that asserts a
 * function is MOUNTED cannot assert that it DOES anything, and mounting was the
 * only property anything here checked.
 *
 * Asserted AFTER an await on purpose. The synchronous call proves nothing about
 * AsyncLocalStorage - the whole reason this design was chosen over an explicit
 * argument is that the classification has to survive into a repository call
 * four awaits down, and a test that reads it before yielding would pass against
 * a plain global.
 */
describe('participantRuntimeWork', () => {
  const buildApp = (middleware: express.RequestHandler[]) => {
    const app = express();
    app.get(
      '/probe',
      ...middleware,
      async (_req: Request, res: Response) => {
        const beforeAwait = currentRuntimeWorkClass();
        await new Promise((resolve) => setImmediate(resolve));
        const afterAwait = currentRuntimeWorkClass();
        await new Promise((resolve) => setTimeout(resolve, 5));
        // A nested async scope, because the real consumer is a repository
        // function called from a handler, not the handler itself.
        const deep = await (async () => {
          await new Promise((resolve) => setImmediate(resolve));
          return currentRuntimeWorkClass();
        })();
        res.json({ beforeAwait, afterAwait, deep });
      }
    );
    return app;
  };

  it('classifies the request as participant work, and keeps it across every await', async () => {
    const response = await request(buildApp([participantRuntimeWork])).get('/probe');

    expect(response.body).toEqual({
      beforeAwait: 'participant',
      afterAwait: 'participant',
      deep: 'participant'
    });
  });

  it('leaves an unmarked route on the capped admin default', async () => {
    // The negative half. Without it, a middleware that classified EVERYTHING as
    // participant would pass the assertion above and exempt the whole
    // application from the cap.
    const response = await request(buildApp([])).get('/probe');

    expect(response.body).toEqual({
      beforeAwait: 'admin',
      afterAwait: 'admin',
      deep: 'admin'
    });
  });

  it('does not leak the classification into the next request', async () => {
    const app = express();
    app.get('/marked', participantRuntimeWork, async (_req, res) => {
      await new Promise((resolve) => setImmediate(resolve));
      res.json({ workClass: currentRuntimeWorkClass() });
    });
    app.get('/unmarked', async (_req, res) => {
      await new Promise((resolve) => setImmediate(resolve));
      res.json({ workClass: currentRuntimeWorkClass() });
    });

    expect((await request(app).get('/marked')).body.workClass).toBe('participant');
    expect((await request(app).get('/unmarked')).body.workClass).toBe('admin');
    expect((await request(app).get('/marked')).body.workClass).toBe('participant');
  });

  it('classifies the public lane as public, not as participant', async () => {
    // The same hole as the one this file exists for, one middleware along.
    // `publicRuntimeWork` is compared by IDENTITY in the route table, so
    // rewriting its body to call `runAsParticipantWork` would put the
    // anonymous, pre-consent brief route back in the UNCAPPED lane with every
    // route-table assertion still green - reopening the finding both gates
    // raised. Only executing it can see that.
    const response = await request(buildApp([publicRuntimeWork])).get('/probe');

    expect(response.body).toEqual({
      beforeAwait: 'public',
      afterAwait: 'public',
      deep: 'public'
    });
  });

  it('keeps the two lanes distinct, so neither can be spelled as the other', async () => {
    const participant = await request(buildApp([participantRuntimeWork])).get('/probe');
    const publicLane = await request(buildApp([publicRuntimeWork])).get('/probe');

    expect(participant.body.deep).not.toBe(publicLane.body.deep);
  });
});
