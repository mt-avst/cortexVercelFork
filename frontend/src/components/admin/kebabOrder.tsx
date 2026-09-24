import React from 'react';
import { DropdownItem } from '../ui';

export interface StudyKebabOrderInput {
  /** Below 1024px (AC7) the row's own state button (Fix/Edit/Analytics/
   * Preview) is gone - no room beside a compact list item's kebab - so one
   * of the three items below leads the menu instead of the fixed
   * Edit/Preview/Analytics order. */
  isCompactActions: boolean;
  canManage: boolean;
  /** Published but failing its own readiness (Admin.tsx `isStudyBroken`):
   * the Edit item reads "Fix" instead - the same word
   * the row's own state button uses for the identical target. */
  notWorking: boolean;
  editPath: string;
  previewPath: string;
  analyticsPath: string;
  /** The study owner's display name, for the disabled Analytics item's
   * reason when the viewer cannot manage this study. */
  ownerName: string;
  /** The row's own primary action link (Admin.tsx `getPrimaryStudyAction`).
   * Matched by `.to` rather than by label: Fix and
   * Edit both target `editPath`, so either label still leads with the Edit
   * item. */
  primaryActionTo: string;
}

/**
 * Edit, Preview as participant, Analytics (Petra 3.4's default order) -
 * unless the compact list needs one of them promoted to lead the menu.
 *
 * Extracted out of `Admin.tsx` - one of two blocks pulled out to keep that
 * file's size down, the other being the phone filter
 * toolbar (`components/admin/PhoneStudyFilters.tsx`). Was an inline IIFE
 * with JSX-style comments sitting inside a function body; a real function
 * with ordinary `//` comments reads better and is independently testable.
 */
export const orderStudyKebabActions = ({
  isCompactActions,
  canManage,
  notWorking,
  editPath,
  previewPath,
  analyticsPath,
  ownerName,
  primaryActionTo,
}: StudyKebabOrderInput): React.ReactNode => {
  const editLabel = notWorking ? 'Fix' : 'Edit';
  const editItem = canManage ? (
    <DropdownItem key="edit" to={editPath}>{editLabel}</DropdownItem>
  ) : (
    <DropdownItem key="edit" disabled title="Only the owner can edit this study">
      {editLabel}
    </DropdownItem>
  );
  const previewItem = (
    <DropdownItem key="preview" to={previewPath}>
      Preview as participant
    </DropdownItem>
  );
  // Analytics is owner-scoped on the server (a non-owner gets a 403), so the
  // menu tells the truth up front rather than opening onto a 403.
  const analyticsItem = canManage ? (
    <DropdownItem key="analytics" to={analyticsPath}>
      Analytics
    </DropdownItem>
  ) : (
    <DropdownItem key="analytics" disabled title={`Only ${ownerName} can view analytics for this study`}>
      Analytics
    </DropdownItem>
  );

  if (!isCompactActions) {
    return (
      <>
        {editItem}
        {previewItem}
        {analyticsItem}
      </>
    );
  }

  const byTarget: Record<string, React.ReactNode> = {
    [editPath]: editItem,
    [previewPath]: previewItem,
    [analyticsPath]: analyticsItem,
  };
  const lead = byTarget[primaryActionTo];
  const rest = [editItem, previewItem, analyticsItem].filter((item) => item !== lead);
  return (
    <>
      {lead}
      {rest}
    </>
  );
};
