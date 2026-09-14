import { describe, it, expect } from 'vitest';
import { getStudyTypeGlyph, STUDY_TYPE_KEYS } from '../studyTypeIcons';

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
});
