import { describe, it, expect } from 'vitest';
import { getStudyTypeGlyph, getStudyTypeAccentVar, STUDY_TYPE_KEYS } from '../studyTypeIcons';
import { getTypeBadgeClass, getCardHoverColor } from '../opportunityUtils';

/**
 * Decision 6 (second-pass review, decided 2026-09-13): the six-colour
 * lozenge system gets one lucide glyph per type, on both the participant
 * listing and the admin table. One lookup backs both surfaces so they
 * cannot drift onto different glyphs for the same type.
 */
describe('getStudyTypeGlyph', () => {
  it('maps every known type to a glyph', () => {
    for (const type of STUDY_TYPE_KEYS) {
      expect(getStudyTypeGlyph(type), `expected a glyph for "${type}"`).not.toBeNull();
    }
  });

  it('gives each of the six types a DISTINCT glyph (a six-colour system with one shared icon would not read as six)', () => {
    const glyphs = STUDY_TYPE_KEYS.map((type) => getStudyTypeGlyph(type));
    expect(new Set(glyphs).size).toBe(STUDY_TYPE_KEYS.length);
  });

  it('normalises a status-concatenated type the same way getTypeBadgeClass does', () => {
    expect(getStudyTypeGlyph('testpublished')).toBe(getStudyTypeGlyph('test'));
    expect(getStudyTypeGlyph('unmoderateddraft')).toBe(getStudyTypeGlyph('unmoderated'));
  });

  it('returns null for an unrecognised or missing type rather than a default glyph', () => {
    expect(getStudyTypeGlyph('bogus')).toBeNull();
    expect(getStudyTypeGlyph(null)).toBeNull();
    expect(getStudyTypeGlyph(undefined)).toBeNull();
  });

  // A review gate flagged that `getTypeBadgeClass` and `getCardHoverColor`
  // each carried their own copy of the status-suffix-stripping logic
  // `baseTypeOf` claims to centralise, so a glyph and its lozenge colour
  // could in principle drift onto different types. Both now call the same
  // `baseTypeOf`; this pins the coupling directly rather than trusting that
  // two independent implementations happen to agree.
  it.each([
    'test', 'interview', 'poll', 'survey', 'question', 'unmoderated',
    'testpublished', 'unmoderateddraft', 'testclosed', 'bogus', '',
  ] as const)('a glyph exists exactly when getTypeBadgeClass renders a lozenge: %s', (type) => {
    expect(getStudyTypeGlyph(type) !== null).toBe(getTypeBadgeClass(type).startsWith('lozenge'));
  });

  it('a glyph exists exactly when getTypeBadgeClass renders a lozenge: null/undefined', () => {
    expect(getStudyTypeGlyph(null) !== null).toBe(getTypeBadgeClass(null).startsWith('lozenge'));
    expect(getStudyTypeGlyph(undefined) !== null).toBe(getTypeBadgeClass(undefined).startsWith('lozenge'));
  });
});

/**
 * The per-type accent used by the browse kicker, filter chips and setup pods.
 * It backs the same six-colour system as the glyph, so it must exist for
 * exactly the same set of types - and it must resolve to the actual lozenge
 * token, not a typo that compiles and silently falls back to the plain colour.
 */
describe('getStudyTypeAccentVar', () => {
  const EXPECTED: Record<string, string> = {
    test: 'var(--lozenge-usertest-text)',
    interview: 'var(--lozenge-interview-text)',
    poll: 'var(--lozenge-poll-text)',
    survey: 'var(--lozenge-survey-text)',
    question: 'var(--lozenge-question-text)',
    unmoderated: 'var(--lozenge-unmoderated-text)',
  };

  it('resolves each known type to its exact lozenge-text token (pinned as literals)', () => {
    for (const type of STUDY_TYPE_KEYS) {
      expect(getStudyTypeAccentVar(type), `wrong accent token for "${type}"`).toBe(EXPECTED[type]);
    }
  });

  it('gives each of the six types a DISTINCT colour', () => {
    const accents = STUDY_TYPE_KEYS.map((type) => getStudyTypeAccentVar(type));
    expect(new Set(accents).size).toBe(STUDY_TYPE_KEYS.length);
  });

  it('normalises a status-concatenated type like the glyph does', () => {
    expect(getStudyTypeAccentVar('testpublished')).toBe(getStudyTypeAccentVar('test'));
    expect(getStudyTypeAccentVar('unmoderateddraft')).toBe(getStudyTypeAccentVar('unmoderated'));
  });

  it('returns null for an unrecognised or missing type (not "transparent", not a wrong colour)', () => {
    expect(getStudyTypeAccentVar('bogus')).toBeNull();
    expect(getStudyTypeAccentVar('')).toBeNull();
    expect(getStudyTypeAccentVar(null)).toBeNull();
    expect(getStudyTypeAccentVar(undefined)).toBeNull();
  });

  // An accent exists exactly when a glyph does: the two halves of one identity
  // system must cover the same types, or a row gets a colour with no icon (or
  // the reverse). Pinned directly rather than trusting two lookups agree.
  it.each([
    'test', 'interview', 'poll', 'survey', 'question', 'unmoderated',
    'testpublished', 'unmoderateddraft', 'bogus', '',
  ] as const)('an accent exists exactly when a glyph does: %s', (type) => {
    expect(getStudyTypeAccentVar(type) !== null).toBe(getStudyTypeGlyph(type) !== null);
  });

  // Delegation contract: it is getCardHoverColor with 'transparent' mapped to
  // null. If that helper's mapping ever changes, this fails rather than the two
  // silently diverging.
  it('stays in lockstep with getCardHoverColor', () => {
    for (const type of [...STUDY_TYPE_KEYS, 'bogus', '']) {
      const hover = getCardHoverColor(type);
      expect(getStudyTypeAccentVar(type)).toBe(hover === 'transparent' ? null : hover);
    }
  });
});
