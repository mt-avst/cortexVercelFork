import React from 'react';
import { SlidersHorizontal, X } from 'lucide-react';

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

interface StudyFacetsProps {
  /** The values actually present across the loaded studies. */
  options: FacetOptions;
  /** The current selection. */
  selection: StudyFacetSelection;
  /** Called with the next selection on any toggle or clear. */
  onChange: (next: StudyFacetSelection) => void;
}

const toggle = <T,>(list: readonly T[], value: T): T[] =>
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

interface FacetGroupProps<T extends string> {
  label: string;
  values: readonly T[];
  selected: readonly T[];
  labelFor: (value: T) => string;
  onToggle: (value: T) => void;
}

function FacetGroup<T extends string>({ label, values, selected, labelFor, onToggle }: FacetGroupProps<T>) {
  if (values.length === 0) {
    return null;
  }
  return (
    <div className="study-facets__group" role="group" aria-label={label}>
      <span className="study-facets__group-label">{label}</span>
      <div className="study-facets__chips">
        {values.map((value) => {
          const isActive = selected.includes(value);
          return (
            <button
              key={value}
              type="button"
              className={`filter-chip${isActive ? ' is-active' : ''}`}
              aria-pressed={isActive}
              onClick={() => onToggle(value)}
            >
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
const StudyFacets: React.FC<StudyFacetsProps> = ({ options, selection, onChange }) => {
  const activeCount = facetSelectionCount(selection);
  const hasAnyOption =
    options.roles.length > 0 ||
    options.types.length > 0 ||
    options.deliveries.length > 0 ||
    options.timeBuckets.length > 0;

  if (!hasAnyOption) {
    return null;
  }

  return (
    <section className="study-facets" aria-label="Filter studies">
      <div className="study-facets__header">
        <span className="study-facets__title">
          <SlidersHorizontal size={15} aria-hidden="true" />
          Filter
          {activeCount > 0 && <span className="study-facets__count"> · {activeCount}</span>}
        </span>
        {activeCount > 0 && (
          <button
            type="button"
            className="btn btn-link study-facets__clear"
            onClick={() => onChange(EMPTY_FACET_SELECTION)}
          >
            <X size={14} aria-hidden="true" />
            Clear all
          </button>
        )}
      </div>

      <FacetGroup
        label="Type"
        values={options.types}
        selected={selection.types}
        labelFor={(t) => getParticipantFacingType(t)}
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
