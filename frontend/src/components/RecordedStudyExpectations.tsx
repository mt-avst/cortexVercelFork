import React from 'react';
import { Mic, Clock, ListChecks, Chrome, ShieldCheck, StopCircle } from 'lucide-react';

import type { RecordedStudyBrief } from '@shared/types';

type RecordedStudyExpectationsProps = {
  /**
   * The study's own shape. `null` when it has not loaded, or could not be
   * loaded - see the render for why that is not treated as a reason to say
   * nothing.
   */
  brief: RecordedStudyBrief | null;
};

/**
 * What a participant is agreeing to, stated before they agree to it.
 *
 * The landing page for a recorded study used to carry the title, whatever one
 * line the researcher typed, and a button that starts a screen-and-voice
 * recording. Everything reassuring about it - that it is self-guided, that the
 * camera is never touched, that it takes twenty minutes - was only ever present
 * if the researcher happened to write it into the description. A study whose
 * description reads "THIS IS A TEST" gave the participant nothing at all.
 *
 * So this block is PRODUCT-SUPPLIED, not authored. A researcher cannot edit it,
 * cannot shorten it, and cannot leave it out, because the promises in it are
 * only worth anything if they hold for every study.
 *
 * Two rules govern what goes in it:
 *
 * 1. **The disclosure is never contingent on a fetch.** The constant facts
 *    render whether or not `brief` arrived. A failed network call must not be
 *    able to produce a page that asks someone to start recording without
 *    telling them they are being recorded.
 * 2. **It never carries the task prompts, only their count.** A participant who
 *    reads all the tasks up front rehearses the route and the recording
 *    captures a performance instead of a first encounter. The welcome screen
 *    stopped listing them for exactly this reason, and the endpoint behind this
 *    component refuses to serve them.
 */
export function RecordedStudyExpectations({ brief }: RecordedStudyExpectationsProps) {
  // Zero is treated as unknown, not as a fact. A study whose only step is the
  // terminal `end` marker would otherwise read "0 tasks, worked through one at
  // a time", which is worse than saying nothing.
  const taskCount = brief?.task_count ? brief.task_count : null;

  return (
    <section className="recorded-study-expectations" aria-labelledby="recorded-study-expectations-heading">
      <h2 id="recorded-study-expectations-heading" className="recorded-study-expectations__heading">
        Before you start
      </h2>

      {/* Attribution, for the same reason the floating pane carries a
          non-authorable trust header. The title, purpose and description above
          this block are all researcher-authored and render in the same
          typography, so without a marker a researcher could write their own
          "Before you start: nothing is recorded until you press record" and a
          participant would read it as coming from Cortex. */}
      <p className="recorded-study-expectations__source">
        From Cortex. This applies to every recorded session, and researchers cannot change it
      </p>

      <ul className="recorded-study-expectations__list">
        {/* First, and unconditional. This is the sentence the whole block exists
            to guarantee gets said. */}
        <li className="recorded-study-expectations__item">
          <Mic size={18} aria-hidden="true" />
          <span>
            Cortex <strong>records your screen and your voice</strong> while you work, and{' '}
            <strong>never your camera</strong>
          </span>
        </li>

        {taskCount !== null && (
          <li className="recorded-study-expectations__item">
            <ListChecks size={18} aria-hidden="true" />
            <span>
              {taskCount} {taskCount === 1 ? 'task' : 'tasks'}, worked through one at a time
            </span>
          </li>
        )}

        <li className="recorded-study-expectations__item">
          <Clock size={18} aria-hidden="true" />
          <span>On your own, in your own time. No moderator and no meeting to attend</span>
        </li>

        <li className="recorded-study-expectations__item">
          <ShieldCheck size={18} aria-hidden="true" />
          <span>You will be asked to agree before anything is recorded</span>
        </li>

        {/* This sentence describes the product as it is, not as it should be.
            There is no stop control in the recording flow: the only way out is
            the browser's own "Stop sharing", and the partial recording is then
            uploaded automatically rather than discarded. The security gate
            caught the earlier wording - "you can stop at any time, and you do
            not have to say why" - promising a control that does not exist, on
            the surface a participant relies on to consent.

            A real "Stop and end this session" control is the right fix and is
            queued as its own piece of work. It lives in ParticipantSessionFlow,
            StudyRunner and session-recorder, which are the three files the
            unpushed participant-launch rework changes most heavily, so it lands
            on top of that branch rather than colliding with it. Tighten this
            copy the day that control exists - not before. */}
        <li className="recorded-study-expectations__item">
          <StopCircle size={18} aria-hidden="true" />
          <span>
            You can end the recording whenever you want, by stopping the screen share.
            Anything recorded up to that point is still sent to the research team
          </span>
        </li>

        {/* NOT "you will need Chrome". Chromium is required only for the
            FLOATING pane (task-pip.ts: "Chromium-only (116+)"); Firefox and
            Safari run the study perfectly well and simply keep the two-window
            flow. Stating a hard requirement that is not one turns people away
            from a study they could have taken part in - and it was another
            claim written without checking it. */}
        <li className="recorded-study-expectations__item">
          <Chrome size={18} aria-hidden="true" />
          <span>
            Best in Google Chrome, where the tasks float in a small window above
            the page. Other browsers work too, with the tasks in a second window
          </span>
        </li>
      </ul>
    </section>
  );
}

export default RecordedStudyExpectations;
