import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import StudyTypePicker from '../StudyTypePicker';
import { OPPORTUNITY_TYPES } from '@shared/constants';
import { getParticipantFacingType } from '../../../utils/opportunityUtils';

// The authoring form is where a type gets its name in a researcher's head, and
// it used to use its own vocabulary: "User Test", "Unmoderated Testing". The
// dashboard badge said "APP TESTING" and "UNMODERATED"; browse said "Usability
// test" and "Recorded study". Three names for one thing. The picker (formerly
// folded into this step's body, now the whole of step 1 on its own) may not
// call a type something no other surface calls it.
//
// Moved here from BasicInfoTab.type-names.test.tsx when the reshape split the
// picker out of Basic Info into its own step: BasicInfoTab no longer renders
// it at all, so the naming rule this file pins is a fact about StudyTypePicker,
// not about Basic Info.

const renderPicker = () =>
  render(
    <StudyTypePicker
      type=""
      deliveryMode="external"
      onSelect={vi.fn()}
      isPublished={false}
    />
  );

const podNames = () =>
  screen
    .getAllByRole('radio')
    .map((pod) => pod.getAttribute('aria-label') ?? '');

describe('StudyTypePicker study-type picker pod names', () => {
  it('offers a pod for every type', () => {
    renderPicker();
    const names = podNames();
    for (const type of Object.values(OPPORTUNITY_TYPES)) {
      const facing = getParticipantFacingType(type);
      expect(
        names.some((name) => name.startsWith(facing)),
        `no pod for "${type}"`
      ).toBe(true);
    }
  });

  it('names each one the way every other surface names it', () => {
    renderPicker();
    for (const type of Object.values(OPPORTUNITY_TYPES)) {
      const facing = getParticipantFacingType(type);
      // The pod TITLE is the canonical participant-facing name, shown in view.
      expect(
        screen.getAllByText(facing).length,
        `no pod titled "${facing}" for "${type}"`
      ).toBeGreaterThan(0);
    }
  });

  it('does not reintroduce the names only this form used', () => {
    renderPicker();
    // Scoped to the pod NAMES rather than the whole picker's text: the rule is
    // about what a pod is CALLED, not its descriptive prose - which is free to
    // use a clinical word like "unmoderated" to explain what a mode means
    // (the "Recorded session" pod's gloss does exactly that) without that word
    // becoming the type's name anywhere a participant reads it.
    const names = podNames();
    expect(names.some((name) => /user test/i.test(name))).toBe(false);
    expect(names.some((name) => /unmoderated/i.test(name))).toBe(false);
  });

  it('keeps each type definition in view, not hidden behind a dropdown', () => {
    renderPicker();
    expect(screen.getByText('Research interview session')).toBeInTheDocument();
    expect(screen.getByText('Usability test you moderate')).toBeInTheDocument();
    expect(screen.getByText('Quick opinion gathering')).toBeInTheDocument();
  });
});
