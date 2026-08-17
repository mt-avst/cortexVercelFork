import { describe, it, expect } from 'vitest';

import { getEligibilityNote } from '../opportunityUtils';

/**
 * The browse row and the study page were each deciding, separately, what to say
 * about who can take part - and they disagreed. The row deliberately said
 * nothing for `any` ("Open To All" on nearly every row was noise); the page
 * printed "Any" unconditionally, directly above a panel telling the reader the
 * study needs a Cortex account and will not work for anyone outside the
 * organisation. Two answers to one question, on one screen.
 *
 * "Any" is the untrue one. Participation always needs an account, and for a
 * recorded study `external` is refused server-side outright. The value only
 * carries information when it NARROWS who can take part, so that is the only
 * time either surface says anything - and now they say it from one function.
 */
describe('getEligibilityNote', () => {
  it('says nothing for "any", because it neither narrows nor is true as written', () => {
    expect(getEligibilityNote({ participant_type_required: 'any' })).toBeNull();
  });

  it('says nothing for "internal", because everyone with a Cortex account already is', () => {
    expect(getEligibilityNote({ participant_type_required: 'internal' })).toBeNull();
  });

  it('says nothing when the value is missing or unrecognised', () => {
    expect(getEligibilityNote({})).toBeNull();
    expect(getEligibilityNote({ participant_type_required: undefined })).toBeNull();
    expect(
      getEligibilityNote({ participant_type_required: 'nonsense' as never })
    ).toBeNull();
  });

  it('warns for "external", which genuinely changes who can take part', () => {
    expect(getEligibilityNote({ participant_type_required: 'external' })).toBe(
      'External participants only'
    );
  });

  it('gives the researcher\'s own criteria for "specific"', () => {
    expect(
      getEligibilityNote({
        participant_type_required: 'specific',
        participant_type_specific_details: 'Jira admins who have run a migration',
      })
    ).toBe('Jira admins who have run a migration');
  });

  it('says nothing for "specific" with no criteria, rather than the bare word', () => {
    // The form requires at least ten characters whenever `specific` is chosen,
    // so this is a legacy row. "Specific" alone warns without informing - it
    // tells someone they might be ineligible and gives them no way to know.
    expect(getEligibilityNote({ participant_type_required: 'specific' })).toBeNull();
    expect(
      getEligibilityNote({
        participant_type_required: 'specific',
        participant_type_specific_details: '   ',
      })
    ).toBeNull();
  });
});
