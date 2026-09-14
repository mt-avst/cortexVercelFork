import { ArrowDown, ArrowUp } from 'lucide-react';
import { Icon } from './Icon';

export interface SortCaretProps {
  /** Whether this column is the one currently sorted on. */
  active: boolean;
  direction: 'asc' | 'desc';
}

/**
 * The one sort-direction indicator for every sortable column header. Four
 * tables (Admin, AdminFeedback, ParticipantsTab, SessionsTab) each rendered
 * `{active ? (asc ? ' ↑' : ' ↓') : ''}` independently, so a font without
 * those glyphs, or a future icon-system change, would have had to be applied
 * four times. The header cell itself carries `aria-sort`; this is decorative.
 */
export function SortCaret({ active, direction }: SortCaretProps) {
  return (
    <span className="admin-th-sort-caret" aria-hidden="true">
      {active && <Icon icon={direction === 'asc' ? ArrowUp : ArrowDown} size={14} />}
    </span>
  );
}
