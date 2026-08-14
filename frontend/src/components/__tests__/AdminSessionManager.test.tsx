import { describe, it, expect } from 'vitest';

import { resolveSaveOutcome } from '../AdminSessionManager';

// For test and interview studies this component IS the save button - tab 3 has
// no Create control of its own, only `onOpportunitySave`. What it does with the
// answer decides whether a refused save is reported honestly or announced as a
// success, because the parent's navigation callback says "Opportunity created
// successfully!" on the way out.
describe('resolveSaveOutcome', () => {
  it('creates the sessions when the save returned a new opportunity', () => {
    expect(resolveSaveOutcome('opp-new', '', undefined, '')).toBe('create-sessions');
  });

  it('reports not-saved when the save came back with no id at all', () => {
    // The shape of a refusal: handleSubmit returns undefined, the prop is empty
    // because nothing has been created yet, and the URL still says 'new'.
    expect(resolveSaveOutcome(undefined, '', 'new', '')).toBe('not-saved');
    expect(resolveSaveOutcome(null, null, undefined, null)).toBe('not-saved');
  });

  it('does not mistake the literal /new route segment for an opportunity id', () => {
    expect(resolveSaveOutcome(undefined, undefined, 'new', undefined)).toBe('not-saved');
    expect(resolveSaveOutcome(undefined, undefined, 'opp-7', undefined)).toBe('create-sessions');
  });

  it('reports already-saved when the id is unchanged, so sessions are not created twice', () => {
    expect(resolveSaveOutcome('opp-1', 'opp-1', undefined, 'opp-1')).toBe('already-saved');
  });

  it('prefers the id the save returned over the one it was mounted with', () => {
    expect(resolveSaveOutcome('opp-fresh', 'opp-stale', 'opp-url', 'opp-stale')).toBe(
      'create-sessions'
    );
  });
});
