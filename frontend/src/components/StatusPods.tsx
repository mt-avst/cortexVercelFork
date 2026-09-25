import React from 'react';
import { CheckCircle, Circle } from 'lucide-react';
import './status-pods.css';

/**
 * A tone maps a pod to the same colour recipe the Admin table's own status
 * pills use (`--status-success` / `--status-warning`, plus a neutral "closed"
 * treatment - see `.admin-study-status--*` in `styles/_components.css`), so a
 * state reads the same colour on the table and here.
 */
export type StatusPodTone = 'success' | 'warning' | 'neutral';

export interface StatusPodOption<T extends string = string> {
  value: T;
  /** The pod's name, e.g. "Draft". */
  label: string;
  /** The one-line meaning, always visible under the name, e.g. "Not visible to users". */
  meaning: string;
  tone: StatusPodTone;
}

export interface StatusPodsProps<T extends string> {
  /** Radio `name`, and the base of every id this group mints. */
  name: string;
  /** The id of the heading (or other element) that names the group, via `aria-labelledby`. */
  legendId: string;
  options: ReadonlyArray<StatusPodOption<T>>;
  value: T;
  onChange: (value: T) => void;
  /** `aria-describedby` id(s) for the group itself - help text, an error. */
  describedBy?: string;
  invalid?: boolean;
}

/**
 * A radio group of status pods (#167): name + one-line meaning always
 * visible, replacing a `<select>` on both Review (draft/published) and
 * StudyEditor (draft/launched/archived) - see each call site for its own
 * option list.
 *
 * Native `<input type="radio">` + `<label>` per pod, not a custom
 * button-`role="radio"` group: arrow keys, Tab and screen-reader semantics
 * come from the browser, so this control is at least as accessible as the
 * `<select>` it replaces without reimplementing roving tabindex by hand.
 *
 * The radio itself is visually hidden (`.visually-hidden`, the same clip
 * technique the app already uses for screen-reader-only text) rather than
 * `display: none`, so it stays in the tab order and keeps native focus; the
 * `<label>` is the whole visible, clickable pod, coloured by `tone` only once
 * selected - the unselected pod still reads as a plain, clickable card (an
 * empty radio ring, not blank space, in its glyph slot, so the control's own
 * shape stays legible before a choice is made) so neither reads as disabled.
 *
 * `data-count` on the group carries the option count into CSS
 * (`status-pods.css`): 3 pods (StudyEditor) need a wider fixed 3-column grid
 * to keep each meaning line on one row, where 2 pods (Review) already fit
 * the default responsive one.
 *
 * Every option's `<input>` carries a STABLE id, `${name}-${value}` - never a
 * moving one. An earlier build minted `id={name}` on whichever option was
 * currently checked, on the theory that OpportunityForm's generic
 * `document.getElementById(pendingFocusFieldId).focus()` focus-on-error path
 * would want a stable `#status` to land on after the `<select>` swap. That
 * caller does not exist: `status` has no `FIELD_LOCATIONS` entry in
 * `OpportunityForm.tsx` (deliberately - no validator there ever sets
 * `errors.status`), so nothing in production ever looks up `status` or
 * `study-status` by id. A stable id is simply the right default for a radio
 * group's own inputs.
 */
function StatusPods<T extends string>({
  name,
  legendId,
  options,
  value,
  onChange,
  describedBy,
  invalid
}: StatusPodsProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-labelledby={legendId}
      aria-describedby={describedBy}
      aria-invalid={invalid ? 'true' : 'false'}
      className="status-pods"
      data-count={options.length}
    >
      {options.map((option) => {
        const checked = option.value === value;
        const inputId = `${name}-${option.value}`;
        return (
          <div className="status-pod-wrap" key={option.value}>
            <input
              type="radio"
              id={inputId}
              name={name}
              value={option.value}
              checked={checked}
              onChange={() => onChange(option.value)}
              className="visually-hidden status-pod-input"
            />
            <label
              htmlFor={inputId}
              className={`status-pod status-pod--${option.tone}${checked ? ' is-selected' : ''}`}
            >
              {/*
                Checked: a filled CheckCircle, coloured by tone (below).
                Unchecked: an empty ring in the SAME slot - not blank space -
                so the pod's clickable, radio-like shape is legible before a
                choice is made and the meaning text lines up across every pod
                in the group, whichever one is currently selected.
              */}
              <span className="status-pod__check" aria-hidden="true">
                {checked ? <CheckCircle size={16} /> : <Circle size={16} />}
              </span>
              <span className="status-pod__text">
                <span className="status-pod__name">{option.label}</span>
                {/*
                  No `id`/`aria-describedby` here: the meaning is already
                  part of this radio's accessible NAME, because the `<label>`
                  wraps both spans - describing it a second time announced it
                  twice. `describedBy` (help text, an error) is wired on the
                  GROUP above only, not repeated per radio.
                */}
                <span className="status-pod__meaning">{option.meaning}</span>
              </span>
            </label>
          </div>
        );
      })}
    </div>
  );
}

export default StatusPods;
