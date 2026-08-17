import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';

import { RecordedStudyExpectations } from '../RecordedStudyExpectations';

const BRIEF = {
  task_count: 4,
  records_screen_and_voice: true,
  requires_chromium: true,
};

describe('RecordedStudyExpectations', () => {
  it('says that screen and voice are recorded, and that the camera is not', () => {
    render(<RecordedStudyExpectations brief={BRIEF} />);

    expect(screen.getByText(/records your screen and your voice/i)).toBeVisible();
    expect(screen.getByText(/never your camera/i)).toBeVisible();
  });

  it('states the shape of the study from its own data', () => {
    render(<RecordedStudyExpectations brief={BRIEF} />);

    expect(screen.getByText(/4 tasks, worked through one at a time/i)).toBeVisible();
  });

  // Unmoderated studies have no authored duration - the column default is all
  // there is - so the block must not state one. It did, and said "about 30
  // minutes" above a consent button for every study ever created through the form.
  it('never claims a duration', () => {
    render(<RecordedStudyExpectations brief={BRIEF} />);

    expect(screen.queryByText(/minutes/i)).toBeNull();
    expect(screen.queryByText(/\bhours?\b/i)).toBeNull();
  });

  // The product's promise has to be distinguishable from the researcher's prose
  // above it, or a researcher can write their own reassurance and have it read
  // as coming from Cortex.
  it('attributes itself to Cortex and says researchers cannot change it', () => {
    render(<RecordedStudyExpectations brief={BRIEF} />);

    expect(screen.getByText(/from cortex/i)).toBeVisible();
    expect(screen.getByText(/researchers cannot change it/i)).toBeVisible();
  });

  it('says a single task in the singular', () => {
    render(<RecordedStudyExpectations brief={{ ...BRIEF, task_count: 1 }} />);

    expect(screen.getByText(/1 task\b/i)).toBeVisible();
    expect(screen.queryByText(/1 tasks/i)).toBeNull();
  });

  it('tells the participant they consent before anything is recorded', () => {
    render(<RecordedStudyExpectations brief={BRIEF} />);

    expect(screen.getByText(/asked to agree before anything is recorded/i)).toBeVisible();
  });

  // The product has NO stop control: the only way out is the browser's own
  // "Stop sharing", and the partial recording uploads automatically rather than
  // being discarded. The earlier copy promised a control that does not exist.
  // Both halves are asserted so neither can be dropped and leave a half-truth.
  it('describes stopping as it actually works, including that the partial recording is still sent', () => {
    render(<RecordedStudyExpectations brief={BRIEF} />);

    expect(screen.getByText(/stopping the screen share/i)).toBeVisible();
    expect(screen.getByText(/still sent to the research team/i)).toBeVisible();
    expect(screen.queryByText(/you do not have to say why/i)).toBeNull();
  });

  // Chromium is needed for the FLOATING pane, not for the study. Firefox and
  // Safari keep the two-window flow, so "you will need Google Chrome" turned
  // people away from a study they could have done.
  it('recommends Chrome without claiming the study requires it', () => {
    render(<RecordedStudyExpectations brief={BRIEF} />);

    expect(screen.getByText(/Best in Google Chrome/i)).toBeVisible();
    expect(screen.getByText(/Other browsers work too/i)).toBeVisible();
    expect(screen.queryByText(/you will need google chrome/i)).toBeNull();
  });

  // The disclosure is the reason this component exists. A participant must never
  // reach the CTA without it, so it cannot be contingent on a network call that
  // may have failed.
  it('still discloses the recording when the brief could not be loaded', () => {
    render(<RecordedStudyExpectations brief={null} />);

    expect(screen.getByText(/records your screen and your voice/i)).toBeVisible();
    expect(screen.getByText(/never your camera/i)).toBeVisible();
    expect(screen.getByText(/asked to agree before anything is recorded/i)).toBeVisible();
  });

  it('claims nothing about task count when the brief could not be loaded', () => {
    render(<RecordedStudyExpectations brief={null} />);

    // A COUNT, not the word. The Chrome line legitimately says "the tasks
    // float in a small window", so a bare /tasks/i matched unrelated copy.
    expect(screen.queryByText(/\d+\s+tasks?\b/i)).toBeNull();
    expect(screen.queryByText(/undefined|null|NaN/i)).toBeNull();
    // Without this the conditional could be dropped and the item would render
    // as a bare ", worked through one at a time" - which the three assertions
    // above all miss.
    expect(screen.queryByText(/worked through one at a time/i)).toBeNull();
  });

  // A study whose only step is the terminal end marker counts zero tasks.
  // "0 tasks, worked through one at a time" is worse than saying nothing.
  it('says nothing about tasks when the study reports none', () => {
    render(<RecordedStudyExpectations brief={{ ...BRIEF, task_count: 0 }} />);

    expect(screen.queryByText(/worked through one at a time/i)).toBeNull();
    expect(screen.queryByText(/0 task/i)).toBeNull();
  });
});
