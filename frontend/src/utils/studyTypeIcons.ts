import type { LucideIcon } from 'lucide-react';
import { BarChart3, ClipboardList, HelpCircle, MessageCircle, Users, Video } from 'lucide-react';
import { baseTypeOf, getCardHoverColor } from './opportunityUtils';

/**
 * Decision 6 (second-pass review, decided 2026-09-13): the six-colour
 * lozenge system - `getTypeBadgeClass`'s `lozenge-<type>` classes - gets one
 * lucide glyph per type, shared by the participant listing and the admin
 * table so neither can drift onto a different icon for the same type.
 */
export type StudyTypeKey = 'test' | 'interview' | 'poll' | 'survey' | 'question' | 'unmoderated';

export const STUDY_TYPE_KEYS: readonly StudyTypeKey[] = [
  'test',
  'interview',
  'poll',
  'survey',
  'question',
  'unmoderated',
];

const GLYPH_BY_TYPE: Record<StudyTypeKey, LucideIcon> = {
  test: Users,
  interview: MessageCircle,
  poll: BarChart3,
  survey: ClipboardList,
  question: HelpCircle,
  unmoderated: Video,
};

const isStudyTypeKey = (value: string): value is StudyTypeKey =>
  (STUDY_TYPE_KEYS as string[]).includes(value);

/** The lucide icon for a study type, or null when the type is unrecognised. */
export function getStudyTypeGlyph(type: string | null | undefined): LucideIcon | null {
  const base = baseTypeOf(type);
  return isStudyTypeKey(base) ? GLYPH_BY_TYPE[base] : null;
}

/**
 * The per-type identity colour, as a `var(--lozenge-*-text)` reference (the same
 * six-colour system as the glyph and the lozenge badges, AA-safe in both
 * themes). Returned as a CSS custom-property value so a surface can set it on
 * `--study-type-color` and let its stylesheet do the rest - the browse kicker,
 * the filter chips and the setup pods all read that one property. Null for an
 * unrecognised type, so a caller renders no accent rather than a wrong one.
 *
 * Delegates to `getCardHoverColor` rather than keeping its own type -> token map:
 * that helper already owns exactly this mapping (it returns the same
 * `var(--lozenge-*-text)` per type), and a second copy is precisely the drift
 * the centralised glyph lookup exists to avoid. `getCardHoverColor` returns the
 * CSS keyword `'transparent'` for an unrecognised type, which becomes null here.
 */
export function getStudyTypeAccentVar(type: string | null | undefined): string | null {
  const color = getCardHoverColor(type);
  return color === 'transparent' ? null : color;
}
