import React from 'react';
import { Search, SlidersHorizontal, X, type LucideIcon } from 'lucide-react';

import {
  getParticipantFacingType,
  DELIVERY_LABELS,
  timeBucketLabel,
  facetSelectionCount,
  EMPTY_FACET_SELECTION,
  type FacetOptions,
  type StudyFacetSelection,
  type StudyDelivery,
  type StudyTimeBucket,
} from '../utils/opportunityUtils';
import { getStudyTypeGlyph, getStudyTypeAccentVar } from '../utils/studyTypeIcons';

interface StudyFacetsProps {
  /** The values actually present across the loaded studies. */
  options: FacetOptions;
  /** The current selection. */
  selection: StudyFacetSelection;
  /** Called with the next selection on any toggle or clear. */
  onChange: (next: StudyFacetSelection) => void;
  /**
   * The keyword search box. When `onQueryChange` is passed, the search input
   * renders at the top of the control card (title + purpose search); the panel
   * then shows even with no facet options, since search is always available.
   * Omitted, the panel is facets-only and hides when there is nothing to offer,
   * exactly as before.
   */
  query?: string;
  onQueryChange?: (next: string) => void;
}

const toggle = <T,>(list: readonly T[], value: T): T[] =>
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

interface FacetGroupProps<T extends string> {
  label: string;
  values: readonly T[];
  selected: readonly T[];
  labelFor: (value: T) => string;
  onToggle: (value: T) => void;
  /**
   * Optional per-value identity glyph + colour (the Type axis only). The glyph
   * is decorative (aria-hidden) - the chip's accessible name stays its label -
   * and the colour rides on `--study-type-color`, which the stylesheet turns
   * into the active fill/border. Absent for the plain axes (roles, where, time).
   */
  accentFor?: (value: T) => string | null;
  glyphFor?: (value: T) => LucideIcon | null;
}

function FacetGroup<T extends string>({
  label,
  values,
  selected,
  labelFor,
  onToggle,
  accentFor,
  glyphFor,
}: FacetGroupProps<T>) {
  if (values.length === 0) {
    return null;
  }
  return (
    <div className="study-facets__group" role="group" aria-label={label}>
      <span className="study-facets__group-label">{label}</span>
      <div className="study-facets__chips">
        {values.map((value) => {
          const isActive = selected.includes(value);
          const accent = accentFor?.(value) ?? null;
          const Glyph = glyphFor?.(value) ?? null;
          return (
            <button
              key={value}
              type="button"
              className={`filter-chip${accent ? ' filter-chip--typed' : ''}${isActive ? ' is-active' : ''}`}
              style={accent ? ({ '--study-type-color': accent } as React.CSSProperties) : undefined}
              aria-pressed={isActive}
              onClick={() => onToggle(value)}
            >
              {Glyph && <Glyph size={14} aria-hidden={true} />}
              {labelFor(value)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The browse facet panel (phase 2), above the study list. Every axis narrows the
 * ALREADY-LOADED published set (no new query): AND across axes, OR within an
 * axis. Only values present across the loaded studies are offered, so a chip can
 * never match nothing. The type axis replaces the old single-select chip row
 * with a multi-select.
 */
const StudyFacets: React.FC<StudyFacetsProps> = ({
  options,
  selection,
  onChange,
  query,
  onQueryChange,
}) => {
  const activeCount = facetSelectionCount(selection);
  const hasAnyOption =
    options.roles.length > 0 ||
    options.types.length > 0 ||
    options.deliveries.length > 0 ||
    options.timeBuckets.length > 0;

  const searchValue = query ?? '';
  const hasSearch = onQueryChange !== undefined;
  const hasSearchText = searchValue.trim() !== '';

  // Facets-only and nothing to offer: hide, as before. With search wired, the
  // card always shows - search is available even when no facet chip is.
  if (!hasAnyOption && !hasSearch) {
    return null;
  }

  // Clear-all wipes BOTH the facet selection and the search box, matching the
  // single "Clear search and filters" affordance on the no-match empty state.
  const showClearAll = activeCount > 0 || hasSearchText;
  const clearAll = () => {
    onChange(EMPTY_FACET_SELECTION);
    onQueryChange?.('');
  };

  return (
    <section className="study-facets" aria-label="Filter studies">
      {hasSearch && (
        <div className="study-facets__search">
          <Search size={16} aria-hidden="true" className="study-facets__search-icon" />
          <input
            type="text"
            className="study-facets__search-input"
            placeholder="Search studies by title or purpose"
            value={searchValue}
            onChange={(event) => onQueryChange?.(event.target.value)}
            aria-label="Search studies"
          />
          {hasSearchText && (
            <button
              type="button"
              className="study-facets__search-clear"
              aria-label="Clear search"
              onClick={() => onQueryChange?.('')}
            >
              <X size={16} aria-hidden="true" />
            </button>
          )}
        </div>
      )}

      {hasAnyOption && (
        <div className="study-facets__header">
          <span className="study-facets__title">
            <SlidersHorizontal size={15} aria-hidden="true" />
            Filter
            {activeCount > 0 && <span className="study-facets__count"> · {activeCount}</span>}
          </span>
          {showClearAll && (
            <button
              type="button"
              className="btn btn-link study-facets__clear"
              onClick={clearAll}
            >
              <X size={14} aria-hidden="true" />
              Clear all
            </button>
          )}
        </div>
      )}

      <FacetGroup
        label="Type"
        values={options.types}
        selected={selection.types}
        labelFor={(t) => getParticipantFacingType(t)}
        accentFor={(t) => getStudyTypeAccentVar(t)}
        glyphFor={(t) => getStudyTypeGlyph(t)}
        onToggle={(t) => onChange({ ...selection, types: toggle(selection.types, t) })}
      />

      <FacetGroup
        label="Roles or skills"
        values={options.roles}
        selected={selection.roles}
        labelFor={(r) => r}
        onToggle={(r) => onChange({ ...selection, roles: toggle(selection.roles, r) })}
      />

      <FacetGroup<StudyDelivery>
        label="Where"
        values={options.deliveries}
        selected={selection.deliveries}
        labelFor={(d) => DELIVERY_LABELS[d]}
        onToggle={(d) => onChange({ ...selection, deliveries: toggle(selection.deliveries, d) })}
      />

      <FacetGroup<StudyTimeBucket>
        label="Time"
        values={options.timeBuckets}
        selected={selection.timeBuckets}
        labelFor={(b) => timeBucketLabel(b)}
        onToggle={(b) => onChange({ ...selection, timeBuckets: toggle(selection.timeBuckets, b) })}
      />
    </section>
  );
};

export default StudyFacets;
