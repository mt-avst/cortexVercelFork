import React from 'react';
import { Link } from 'react-router-dom';
import type { Opportunity } from '../../api/types';
import { getTypeBadgeClass, getTimeRemainingUntil, baseTypeOf } from '../../utils/opportunityUtils';
import { runsNativeSurvey } from '@shared/firsthand/delivery';
import {
  getStudyProgress,
  getNextMilestone,
  getDisplayStatus,
  getAdminTypeLabel,
  getPrimaryStudyAction,
  canManageStudy,
  isAutoClosed,
  isNextNoteWarned,
  isStudyBroken,
  relativeDayLabel,
  studyAnalyticsPath,
  studyEditPath,
  studyPreviewPath,
  studyRowPath,
  StudyViewer,
} from '../../utils/adminDashboard';
import { orderStudyKebabActions } from './kebabOrder';
import {
  PUBLISHED_NOT_WORKING_LABEL,
  PUBLISHED_NOT_WORKING_PREFIX,
  PUBLISHED_NOT_WORKING_DESCRIPTION,
} from '../../lib/opportunity-authoring/step-status';
import { Dropdown, DropdownItem, DropdownDivider, Icon } from '../ui';
import { AlertTriangle, MoreVertical } from 'lucide-react';
import { getStudyTypeGlyph, getStudyTypeAccentVar } from '../../utils/studyTypeIcons';
import { useCloseStudyUndo } from '../../hooks/useCloseStudyUndo';
import { ClosedStudyNoticeRow, CopyNoticeRow, StudyActionErrorRow } from '../StudyRowNotices';
import { formatStudyDateCompact, formatClockTime } from '../../utils/datetime';
import type { TableRowKind } from './buildTableRows';

/** The in-place "Copied"/copy-failed status shown under the study it names
 * (Admin.tsx's own `copyNotice` state). */
export interface CopyNoticeState {
  id: string;
  title: string;
  tone: 'status' | 'error' | 'warning';
  message: string;
}

export interface StudyRowProps {
  study: Opportunity;
  kind: TableRowKind;
  user: StudyViewer | null | undefined;
  now: Date;
  isCompactActions: boolean;
  showAllResearchers: boolean;
  navigate: (path: string) => void;
  closeUndo: ReturnType<typeof useCloseStudyUndo>;
  copyNotice: CopyNoticeState | null;
  setCopyNotice: React.Dispatch<React.SetStateAction<CopyNoticeState | null>>;
  refreshAfterCopy: (study: Opportunity, isRetry?: boolean) => Promise<void>;
  copyRetryRef: React.RefObject<HTMLButtonElement>;
  dismissCopyNotice: (id: string) => void;
  onDuplicate: (study: Opportunity) => void;
  onDelete: (id: string, title: string) => void;
}

/**
 * One row of the Research Studies table (or its below-1024px compact card):
 * the study's `<tr>`, its notice/error slots, and the three
 * no-row-above-them variants ('errorSlot', 'noticeOnly', 'reopenNoticeOnly')
 * `buildTableRows` hands out while a Close/Undo/Reopen notice is anchored to
 * a study the live filters no longer show.
 *
 * Extracted out of Admin.tsx's own table map (cto/AdaptaLabs#163) - kept a
 * single component rather than split further because every branch reads the
 * same row-level state (`closeUndo`, `copyNotice`) and threading it through
 * more boundaries would not make any one piece easier to follow.
 */
export const StudyRow: React.FC<StudyRowProps> = ({
  study: opportunity,
  kind,
  user,
  now,
  isCompactActions,
  showAllResearchers,
  navigate,
  closeUndo,
  copyNotice,
  setCopyNotice,
  refreshAfterCopy,
  copyRetryRef,
  dismissCopyNotice,
  onDuplicate,
  onDelete,
}) => {
  const notice = closeUndo.notice?.id === opportunity.id ? closeUndo.notice : null;
  const rowError = closeUndo.actionError?.id === opportunity.id ? closeUndo.actionError : null;
  // A refused Undo's error has its own slot (kind 'errorSlot'); every other
  // error sits under its row.
  const actionError = rowError && !rowError.anchor ? rowError : null;
  // below 1024px a notice must stay inside
  // the ONE grid/flex item its study already is (see
  // components/StudyRowNotices.tsx's own comment) - a card with
  // no row above it (errorSlot/noticeOnly/reopenNoticeOnly) gets
  // its own card chrome so it still reads as one list item, not
  // a bare strip.
  if (kind === 'errorSlot') {
    if (!rowError) return null;
    return isCompactActions ? (
      <tr key={`${opportunity.id}-error-slot`} className="admin-row-clickable admin-row-notice-card">
        <StudyActionErrorRow
          studyId={opportunity.id}
          message={rowError.message}
          onDismiss={closeUndo.dismissError}
          errorRef={closeUndo.errorRef}
          compact
        />
      </tr>
    ) : (
      <StudyActionErrorRow
        key={`${opportunity.id}-error-slot`}
        studyId={opportunity.id}
        message={rowError.message}
        onDismiss={closeUndo.dismissError}
        errorRef={closeUndo.errorRef}
      />
    );
  }
  // Undo is disabled on every notice while any Undo is in
  // flight, so two reopen requests never race.
  const noticeRow = notice && (
    <ClosedStudyNoticeRow
      studyId={notice.id}
      title={notice.title}
      undoing={closeUndo.undoingId !== null}
      onUndo={() => void closeUndo.undo()}
      undoButtonRef={closeUndo.undoButtonRef}
      compact={isCompactActions}
    />
  );
  // The closed study no longer matches the filters: its
  // notice alone holds its place (see buildTableRows).
  if (kind === 'noticeOnly') {
    return isCompactActions ? (
      <tr key={opportunity.id} className="admin-row-clickable admin-row-notice-card">
        {noticeRow}
      </tr>
    ) : (
      <React.Fragment key={opportunity.id}>{noticeRow}</React.Fragment>
    );
  }
  // The mirror case for Reopen - the now-published study
  // left the filtered list (Closed, or Broken if it was
  // also broken), so its "Reopened" notice renders alone,
  // in the sorted slot buildTableRows gave it, with no row
  // above it.
  if (kind === 'reopenNoticeOnly') {
    const reopenNoticeOnlyContent = closeUndo.reopenNotice?.id === opportunity.id && (
      <CopyNoticeRow
        studyId={opportunity.id}
        message={`Reopened “${closeUndo.reopenNotice.title}”`}
        tone="status"
        onDismiss={() => closeUndo.dismissReopenNotice(opportunity.id)}
        compact={isCompactActions}
      />
    );
    return isCompactActions ? (
      <tr key={`${opportunity.id}-reopen-notice-only`} className="admin-row-clickable admin-row-notice-card">
        {reopenNoticeOnlyContent}
      </tr>
    ) : (
      <React.Fragment key={`${opportunity.id}-reopen-notice-only`}>
        {reopenNoticeOnlyContent}
      </React.Fragment>
    );
  }
  const recruitment = getStudyProgress(opportunity);
  // Progress: booked / capacity when the study has sessions
  // (below); otherwise its response count for a native
  // poll/survey/question, else its click count - but only
  // when the server actually sent one. The list endpoint
  // withholds `responses_total`/`clicks_total` (undefined,
  // not 0) for every row they do not apply to, so a missing
  // count is "nothing to show", never "0 responses" or
  // "0 clicks". Drafts show nothing either. A native
  // poll/survey/question never falls back to clicks even if
  // `responses_total` is absent (a failed batch, say) - its
  // click count is page views including admin previews, a
  // different and misleading unit, and question rows have
  // no click count to fall back to anyway.
  const nativeSurvey = runsNativeSurvey(baseTypeOf(opportunity.type), opportunity.delivery_mode);
  const responses = opportunity.status !== 'draft' ? opportunity.responses_total : undefined;
  const clicks = opportunity.status !== 'draft' && !nativeSurvey ? opportunity.clicks_total : undefined;
  const milestone = getNextMilestone(opportunity, now);
  const sessionDayLabel = milestone?.kind === 'session' ? relativeDayLabel(milestone.date, now) : null;
  const TypeGlyph = getStudyTypeGlyph(opportunity.type);
  // The compact list's type icon only (not its text,
  // which stays muted): the same per-type identity
  // colour the browse kicker, filter chips and setup
  // pods already share (`getStudyTypeAccentVar`, !484)
  // rather than a second colour system of its own.
  // Null for an unrecognised type, so the icon falls
  // back to its inherited muted colour instead of a
  // wrong one.
  const typeAccent = getStudyTypeAccentVar(opportunity.type);
  // One call per row: the status cell renders this and
  // also carries it as the label's `title`, and the
  // readiness check reads six fields.
  const notWorking = isStudyBroken(opportunity, now);
  const statusLabel = notWorking ? PUBLISHED_NOT_WORKING_LABEL : getDisplayStatus(opportunity.status);
  const editPath = studyEditPath(opportunity.id);
  // One URL for the row: the title link and a row click
  // both go here - the edit page for someone who can
  // edit, the participant page for anyone else.
  const rowPath = studyRowPath(opportunity, user);
  const canManage = canManageStudy(opportunity, user);
  const primaryAction = getPrimaryStudyAction(opportunity, user, now);
  const owner = opportunity.owner_name || opportunity.owner_email;
  // whether the compact list's line 3
  // (progress + Next) would show nothing but two empty
  // dashes - collapsed by CSS below (`[data-line3-empty]`)
  // rather than kept as dead space. Computed for every
  // width (cheap), read only under 1024px.
  const line3Empty = !recruitment && responses === undefined && clicks === undefined && !milestone;
  return (
    <React.Fragment key={opportunity.id}>
    <tr
      className="admin-row-clickable"
      data-line3-empty={line3Empty || undefined}
      /* The mouse's shortcut to the title link's own URL.
         The keyboard has the link itself (Tab, Enter), so
         the row is not a Tab stop and carries no key
         handling of its own. */
      onClick={(e) => {
        // A plain single click only: not a keyboard-synthesised
        // one (detail 0), not the second click of a double-click
        // (which lands here after a menu item's first click
        // closed the menu over this row), and not a modifier
        // click - the title link is the way to open a new tab.
        if (e.detail !== 1) return;
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        // Nor while a Close is in flight: the menu it came from
        // has gone, and the pointer is over some other row.
        if (closeUndo.isCloseInFlight()) return;

        // Ignore text selection (if user selected text)
        const selection = window.getSelection();
        if (selection && selection.toString().length > 0) return;

        // Only navigate if the click target is not an interactive element
        const target = e.target as HTMLElement;
        const isInteractive = target.closest('button, a, input, select, textarea, [role="button"], .dropdown, .dropdown-menu, .dropdown-item');
        if (!isInteractive) {
          navigate(rowPath);
        }
      }}
    >
      {/* The Study cell names the row: the title (two lines at
          most, and the link to the study) and one meta line -
          the type pill, the owner when every researcher's
          studies are showing, then the purpose one-liner,
          truncated. Clamped strings carry their full text in
          `title`, so nothing is lost. */}
      <td className="col-title" data-label="Study">
        <Link
          to={rowPath}
          className="row-title"
          title={opportunity.title}
          data-study-id={opportunity.id}
        >
          {opportunity.title}
        </Link>
        <div className="admin-study-meta">
          <span className={`admin-pill ${getTypeBadgeClass(opportunity.type)} badge--${opportunity.type}`}>
            {TypeGlyph && (
              <Icon icon={TypeGlyph} size={14} aria-hidden="true" className="lozenge__glyph" />
            )}
            {getAdminTypeLabel(opportunity.type)}
          </span>
          {showAllResearchers && owner && (
            <span className="admin-study-owner" title={`Owner: ${owner}`}>
              <span className="visually-hidden">Owner: </span>
              {owner}
            </span>
          )}
          <small className="row-desc" title={opportunity.purpose_one_liner}>
            {opportunity.purpose_one_liner}
          </small>
        </div>
      </td>
      <td className="col-status" data-label="Status">
        {/* the compact media query's
            `display: flex` on this td now carries `!important`
            (_components.css) - `.admin-data-table td { display:
            block !important }` (the phone/tablet card rule)
            always beat a non-`!important` flex here, so the
            status and type pills touched (~1.5px apart on
            whitespace alone). A wrapper span was tried first, but
            it changed the status label from a direct flex-item
            descendant of this td to one two levels down, and that
            broke the label's own clip on the DESKTOP table -
            e2e/admin-pill-primitive.test.ts caught it rendering
            fully unclipped at 1024/1440. */}
        {/*
          Row 6: four seeded PUBLISHED studies fail their
          own publish readiness (no questions, no
          external link, no venue) while this cell read
          the same as any working study. One word,
          shared with the Review identity card
          (`ReviewStep.tsx`), for "published but not
          working" - computed here from what the
          dashboard's own list response already carries.
          See `isPublishedButNotWorking`'s own comment
          for the one class of breakage this cannot see
          from these fields alone (a native survey or
          unmoderated study with no content).
        */}
        <span
          className={`admin-pill admin-study-status admin-study-status--${opportunity.status}${
            notWorking ? ' admin-study-status--not-working' : ''
          }`}
        >
          {/*
            A broken published study is marked OUTSIDE
            its label too (cto/AdaptaLabs#149): an amber
            fill and a warning glyph that does not
            shrink, so it is never the word alone. The
            label is "Broken" since #157 and fits the
            pill, but the fill and glyph are the Draft
            pill's and do not say "published" - so a
            visually hidden prefix gives a screen reader
            "Published, Broken", and the `title` gives
            hover the full meaning. The glyph is
            decorative beside them.
          */}
          {notWorking && (
            <Icon
              icon={AlertTriangle}
              size={14}
              aria-hidden="true"
              className="admin-study-status__glyph"
            />
          )}
          {notWorking && (
            <span className="visually-hidden">{PUBLISHED_NOT_WORKING_PREFIX}</span>
          )}
          <span
            className="admin-study-status__label"
            title={notWorking ? PUBLISHED_NOT_WORKING_DESCRIPTION : statusLabel}
          >
            {statusLabel}
          </span>
        </span>
        {/* the Auto-closed marker stays on every surface, including
            the compact list; only the field LABELS were ever in
            scope to drop. It sits beside the status pill in both
            table and compact modes, same as today. */}
        {isAutoClosed(opportunity) && (
          <span className="admin-pill admin-pill--auto-closed">Auto-closed</span>
        )}
        {/* Compact list item, line 2: "the status pill, then the
            type glyph and label" - a second copy of the type pill,
            gated on `isCompactActions` rather than a CSS breakpoint. The
            meta line's own type pill (`.admin-study-meta`, hidden below
            1024px) lives inside a DIFFERENT table cell (`col-title`), and
            a CSS grid cannot pull a child out of one grid item into
            another's row - so this cannot just be CSS-repositioned. Real
            conditional rendering rather than `display:none` matters here
            for more than tidiness: jsdom (unit tests) applies no CSS, so
            a CSS-only toggle would put the SAME "Live"/"Recorded"/etc.
            text in the DOM twice at once and every `getByText` on it
            would fail with "multiple elements found" - gating on the
            same hook that already drives the kebab's own compact order
            means jsdom (no `matchMedia`, `isCompactActions` always
            false) never renders a second copy at all. */}
        {/* Muted text, not a second coloured capsule - the status
            pill is the only coloured capsule on the card now. The
            icon alone carries the type's identity colour (the same
            per-type token the browse kicker, filter chips and setup
            pods share, !484) so the type is still scannable at a
            glance without a second heavy pill competing with the
            status one. A list-scoped class
            (`.admin-study-type-compact`), not the shared
            `.admin-pill`/`getTypeBadgeClass` primitive every other
            pill on the page depends on. Desktop is untouched: the
            meta line's own type pill (`.admin-study-meta`, hidden
            below 1024px) still renders the coloured capsule. */}
        {isCompactActions && (
          <span className="admin-study-type-compact">
            {TypeGlyph && (
              <Icon
                icon={TypeGlyph}
                size={14}
                aria-hidden="true"
                style={typeAccent ? { color: typeAccent } : undefined}
              />
            )}
            {getAdminTypeLabel(opportunity.type)}
          </span>
        )}
      </td>
      {/* Under Show all researchers the
          compact list otherwise gives no way to tell whose
          study is whose (55 anonymous items) - the desktop
          meta line's owner is inside `.admin-study-meta`,
          which the compact rule hides outright, so this is a
          second copy, same conditional-render reasoning as
          the type pill above (jsdom has no matchMedia, so no
          duplicate node there). Its own cell, an ordinary
          (non-100%-basis) flex item like Progress and Next
          beside it, rather than forcing a full-width line
          inside col-status: owner then shares line 3 with the
          Next note (left/right) instead of costing its own
          ~20px line every row. "by " is real text (not CSS
          `content`, which some screen readers announce
          inconsistently around generated content, and not
          `aria-hidden`), so the same string is what everyone
          reads. Independent of `line3Empty` below (which only
          ever gates Progress/Next): the owner has nothing to
          do with either being empty and must stay visible on
          its own regardless. */}
      {isCompactActions && showAllResearchers && owner && (
        <td className="col-owner" data-label="Owner">
          <span className="admin-study-owner" title={`Owner: ${owner}`}>
            by {owner}
          </span>
        </td>
      )}
      {/* Progress: booked / capacity across the study's sessions, with
          the same progress bar and percentage the Recruitment cell drew.
          Failing that, a native poll/survey/question shows how many
          people answered (cto/AdaptaLabs#162) - the same count the
          analytics Results tab calls "N participants" - and any other
          published or closed study the server counts clicks for shows
          those instead (the old Clicks column). Anything else - a draft,
          a study with no sessions and no response or click count - shows
          the muted dash. */}
      <td className="col-progress" data-label="Progress">
        {recruitment ? (
          <div className="admin-recruitment">
            <div className="admin-recruitment__top">
              <span className="admin-recruitment__ratio">{recruitment.booked} / {recruitment.capacity}</span>
              <span className="admin-recruitment__pct">{recruitment.pct}%</span>
            </div>
            <div className="progress-mini progress-mini--block">
              <div className="progress-mini__fill" style={{ width: `${recruitment.pct}%` }} />
            </div>
          </div>
        ) : responses !== undefined ? (
          <span className="admin-progress-count">
            {responses} {responses === 1 ? 'response' : 'responses'}
          </span>
        ) : clicks !== undefined ? (
          <span className="admin-progress-count">
            {clicks} {clicks === 1 ? 'click' : 'clicks'}
          </span>
        ) : (
          <span className="admin-cell-empty">–</span>
        )}
      </td>
      {/* Next session / deadline: the soonest upcoming slot, else a future
          closing time, else "Completed" once every slot has passed. All
          from real fields - no invented session ordinal. */}
      {/* The date on its own line ("Thu 24 Sept", the year only
          when it is not this one); a session's clock time leads
          the second line, before its relative day. The note
          turns warning colour inside CLOSING_SOON_DAYS - the
          same horizon as the Closing soon chip and card. */}
      <td className="col-next" data-label="Next / deadline">
        {milestone ? (
          <div className="admin-next">
            <span className="admin-next__date">
              {formatStudyDateCompact(milestone.date, now)}
            </span>
            <span
              className={`admin-next__note admin-next__note--${milestone.kind}${
                isNextNoteWarned(opportunity, now) ? ' admin-next__note--soon' : ''
              }`}
            >
              {milestone.kind === 'session' ? (
                <>
                  <span className="admin-next__time">{formatClockTime(milestone.date.toISOString())}</span>
                  {sessionDayLabel && ` · ${sessionDayLabel}`}
                </>
              ) : milestone.kind === 'completed' ? (
                'Completed'
              ) : milestone.kind === 'closed' ? (
                // Closed by hand before this date: nothing is
                // ahead of it, so no countdown and no colour.
                'Closed early'
              ) : (
                `Closes · ${getTimeRemainingUntil(milestone.date).text ?? 'soon'}`
              )}
            </span>
          </div>
        ) : (
          <span className="admin-cell-empty">–</span>
        )}
      </td>
      <td className="col-date" data-label="Created">
        <small className="admin-cell-metadata">
          {formatStudyDateCompact(opportunity.created_at, now)}
        </small>
      </td>
      <td className="col-actions" data-label="Actions">
        <div className="admin-action-group">
          {/* The next thing to do to the study (Petra 3.4), for
              someone who can act on it: Fix a broken one, Edit a
              draft, Analytics for a live or closed one. Anyone
              else gets Preview as a participant. A link, because
              every one of these is a page: a modifier-click
              opens a new tab. Named with the study, so a list
              of links reads "Fix: <title>", not "Fix, Fix". */}
          <Link
            to={primaryAction.to}
            className={`btn btn-outline-secondary btn-sm admin-action-primary${
              primaryAction.label === 'Fix' ? ' admin-action-primary--fix' : ''
            }`}
            aria-label={`${primaryAction.label}: ${opportunity.title}`}
            onClick={(e) => {
              // Not the second click of a double-click, nor
              // while a Close is in flight (see the row's
              // own guard). Modifier clicks pass through.
              if (e.detail > 1 || closeUndo.isCloseInFlight()) e.preventDefault();
            }}
          >
            {primaryAction.label === 'Fix' && (
              <Icon icon={AlertTriangle} size={14} aria-hidden="true" />
            )}
            {primaryAction.label}
          </Link>
        <Dropdown
          menu
          align="end"
          menuClassName="admin-action-dropdown admin-action-dropdown-menu"
          trigger={
            <button
              className="btn btn-outline-secondary btn-sm admin-action-btn admin-action-btn-kebab"
              type="button"
              // The row is clickable; stop the kebab's own
              // click reaching it (belt-and-braces beside the
              // row's interactive-target guard).
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              aria-label={`Actions for ${opportunity.title}`}
            >
              {/* the drawn box is 32x32 -
                  the button underneath stays the 44x44 hit
                  target (`.admin-action-btn-kebab`, unchanged),
                  but only the compact-list CSS gives this inner
                  span its own visible border/fill, so the kebab
                  stops being the heaviest object on each card. */}
              <span className="admin-action-btn-kebab__box">
                <Icon icon={MoreVertical} size={16} aria-hidden="true" />
              </span>
            </button>
          }
        >
          {/* Everything, in one order (Petra 3.4): Edit, Preview
              as participant, Analytics, Copy | Close study |
              Delete. Items that go to a page are links (`to`).
              The participant page renders a draft for an admin
              (with a Draft badge), so Preview is live for drafts
              too. Edit is the owner's (or a superadmin's): the
              server refuses anyone else's save. Ordering itself
              lives in kebabOrder.tsx now. */}
          {orderStudyKebabActions({
            isCompactActions,
            canManage,
            notWorking,
            editPath,
            previewPath: studyPreviewPath(opportunity.id),
            analyticsPath: studyAnalyticsPath(opportunity.id),
            ownerName: opportunity.owner_name ?? 'the study owner',
            primaryActionTo: primaryAction.to,
          })}
          {/* Copy is the owner's too: the server refuses
              anyone else's with a 403. */}
          {canManage ? (
            <DropdownItem onClick={() => onDuplicate(opportunity)}>
              Copy
            </DropdownItem>
          ) : (
            <DropdownItem disabled title="Only the owner can copy this study">
              Copy
            </DropdownItem>
          )}
          {/* Close study: published studies only, and only for the
              owner or a superadmin - the server's own gate on a
              status change, the same one Analytics reads. Reversible,
              so an Undo notice rather than a confirm. */}
          {opportunity.status === 'published' && canManage && <DropdownDivider />}
          {opportunity.status === 'published' && canManage && (
            <DropdownItem onClick={() => void closeUndo.closeStudy(opportunity)}>
              Close study
            </DropdownItem>
          )}
          {/* Reopen study: the
              mirror of Close, once its own Undo window has passed -
              the only way back to published for a closed study
              otherwise. Same gate as Close/Analytics, and the same
              server-side publish guard Undo already runs, so a
              broken study's refusal shows the same way (under the
              row, the server's own reason). Hidden while THIS
              study's own Undo notice is up:
              that notice's own Undo button already sends the same
              PATCH, and offering a second path to it here raced the
              notice's timer/copy against Reopen's - simplest to have
              exactly one live control for "un-close this study" at a
              time, rather than teaching each path to cancel the
              other's timer and text. */}
          {opportunity.status === 'closed' && canManage && closeUndo.notice?.id !== opportunity.id && <DropdownDivider />}
          {opportunity.status === 'closed' && canManage && closeUndo.notice?.id !== opportunity.id && (
            <DropdownItem
              disabled={closeUndo.reopeningId === opportunity.id}
              onClick={() => void closeUndo.reopenStudy(opportunity)}
            >
              {closeUndo.reopeningId === opportunity.id ? 'Reopening…' : 'Reopen study'}
            </DropdownItem>
          )}
          <DropdownDivider />
          {/* Delete: the server refuses anyone but the owner or a
              superadmin ("Only the owner can delete this study"), so
              offering it to anyone else only ends in an error after
              the confirm. Disabled with the reason, like Edit. */}
          {canManage ? (
            <DropdownItem className="text-danger" onClick={() => onDelete(opportunity.id, opportunity.title)}>
              Delete
            </DropdownItem>
          ) : (
            <DropdownItem className="text-danger" disabled title="Only the owner can delete this study">
              Delete
            </DropdownItem>
          )}
        </Dropdown>
        </div>
      </td>
      {/* below 1024px every notice for this
          study renders HERE, inside its own `<tr>`, rather than as
          a sibling row below - see components/StudyRowNotices.tsx's
          own comment for why a sibling breaks the 800-1023.98px
          grid. Each is its own extra flex child
          (`.admin-data-table td.col-notice`, `flex-basis: 100%`),
          so the card simply grows by a line. */}
      {isCompactActions && noticeRow}
      {isCompactActions && copyNotice?.id === opportunity.id && (
        <CopyNoticeRow
          message={copyNotice.message}
          tone={copyNotice.tone}
          onRetry={() => {
            setCopyNotice({ ...copyNotice, tone: 'status', message: `Copied “${copyNotice.title}”` });
            void refreshAfterCopy(opportunity, true);
          }}
          onDismiss={() => dismissCopyNotice(opportunity.id)}
          actionRef={copyRetryRef}
          compact
        />
      )}
      {isCompactActions && closeUndo.reopenNotice?.id === opportunity.id && (
        <CopyNoticeRow
          studyId={opportunity.id}
          message={`Reopened “${closeUndo.reopenNotice.title}”`}
          tone="status"
          onDismiss={() => closeUndo.dismissReopenNotice(opportunity.id)}
          compact
        />
      )}
      {isCompactActions && actionError && (
        <StudyActionErrorRow
          studyId={opportunity.id}
          message={actionError.message}
          onDismiss={closeUndo.dismissError}
          errorRef={closeUndo.errorRef}
          compact
        />
      )}
    </tr>
    {/* >=1024px only: the desktop table keeps each notice as its
        own full-width sibling row, in place under the row it is
        about (components/StudyRowNotices.tsx). */}
    {!isCompactActions && noticeRow}
    {!isCompactActions && copyNotice?.id === opportunity.id && (
      <CopyNoticeRow
        message={copyNotice.message}
        tone={copyNotice.tone}
        onRetry={() => {
          setCopyNotice({ ...copyNotice, tone: 'status', message: `Copied “${copyNotice.title}”` });
          void refreshAfterCopy(opportunity, true);
        }}
        onDismiss={() => dismissCopyNotice(opportunity.id)}
        actionRef={copyRetryRef}
      />
    )}
    {/* Reopen's own announcement, the
        way Copy's does - CopyNoticeRow itself, role=status, no
        Retry. Rendered under the study's row, which sorts on its
        pre-reopen (closed) snapshot while the notice is up, the
        same freeze Close gives its own row (see `reopenSnapshot`
        in buildTableRows) - so the row, and this notice, stay under
        the reader rather than jumping to their live sort position. */}
    {!isCompactActions && closeUndo.reopenNotice?.id === opportunity.id && (
      <CopyNoticeRow
        studyId={opportunity.id}
        message={`Reopened “${closeUndo.reopenNotice.title}”`}
        tone="status"
        onDismiss={() => closeUndo.dismissReopenNotice(opportunity.id)}
      />
    )}
    {!isCompactActions && actionError && (
      <StudyActionErrorRow
        studyId={opportunity.id}
        message={actionError.message}
        onDismiss={closeUndo.dismissError}
        errorRef={closeUndo.errorRef}
      />
    )}
    </React.Fragment>
  );
};

export default StudyRow;
