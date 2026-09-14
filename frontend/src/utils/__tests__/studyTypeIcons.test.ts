import { describe, it, expect } from 'vitest';
import { getStudyTypeGlyph, STUDY_TYPE_KEYS } from '../studyTypeIcons';
import { getTypeBadgeClass } from '../opportunityUtils';

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
