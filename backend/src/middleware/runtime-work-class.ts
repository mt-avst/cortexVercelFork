import { NextFunction, Request, Response } from 'express';

import {
  runAsParticipantWork,
  runAsPublicWork
} from '../firsthand/runtime-pool-admission';

/**
 * Marks everything downstream as participant-originated work, so its FirstHand
 * runtime-pool checkouts are never queued behind admin traffic.
 *
 * WHY A MIDDLEWARE AND NOT AN ARGUMENT. The classification is a fact about the
 * REQUEST, and the code that needs it is four calls down in a repository -
 * `getStudyById` is read by the authoring form and by the participant mint
 * path, `countStudyTasks` serves the participant landing page. Threading a flag
 * through every repository signature would put the decision in the hands of
 * whoever wrote the query rather than whoever knows who is asking, and every
 * one of those signatures is shared by both callers.
 *
 * `next()` is called INSIDE the AsyncLocalStorage scope, so the rest of the
 * chain and the handler - and everything they await - run within it. Express
 * invokes `next` synchronously, and promise continuations inherit the context,
 * which is what makes this hold across an `await`.
 *
 * ADMIN IS THE DEFAULT, so this is only ever added, never removed: an
 * unmarked route is capped, which is the safe direction. What that costs is
 * that forgetting to mark a participant route makes it quietly slower, and
 * routes/__tests__/runtime-pool-admission-routes.test.ts turns that into a
 * failing test by asserting the marked set in both directions.
 */
export function participantRuntimeWork(
  _req: Request,
  _res: Response,
  next: NextFunction
): void {
  runAsParticipantWork(() => next());
}

/**
 * Marks everything downstream as anonymous, pre-consent work.
 *
 * For `GET /:id/recorded-study-brief`, which is `optionalAuth` and therefore
 * reachable with NO CREDENTIAL. It used to carry `participantRuntimeWork`, on
 * the reasoning that a real participant loads that page - true, and not
 * sufficient. Both review gates and a peer session independently called it the
 * wrong classification: it handed the uncapped lane to the open internet,
 * behind a 600/min bucket that `trust proxy: 1` collapses to a single key, on
 * a handler that takes two runtime checkouts. Anyone holding a published
 * opportunity id - and those travel in Slack links - could saturate the pool
 * that live participants write their answers into.
 *
 * The asymmetry that justifies exempting a participant does not reach here. A
 * refusal on a session WRITE loses answers somebody has already given; a
 * refusal on a landing-page READ costs a reload of a page nobody has started.
 *
 * A logged-in participant loading this page is classified public too, and that
 * is deliberate rather than an oversight: the page is the same page, the cost
 * is the same reload, and branching the class on whether a cookie happens to
 * be present would put the anonymous case on a code path nobody exercises.
 */
export function publicRuntimeWork(
  _req: Request,
  _res: Response,
  next: NextFunction
): void {
  runAsPublicWork(() => next());
}
