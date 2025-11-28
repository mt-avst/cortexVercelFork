import React from 'react';

/**
 * StudyFilters Component
 * 
 * Interactive filter chips for filtering opportunities by study type.
 * Replaces the dropdown selector with a more scannable, touch-friendly UI.
 */

interface StudyFiltersProps {
  currentFilter: string;
  onFilterChange: (filter: string) => void;
}

// Map data values to CSS class modifiers for the design system
const styleMap: Record<string, string> = {
  'test': 'app-testing',
  'survey': 'survey',
  'poll': 'poll',
  'interview': 'interview',
  'question': 'question',
  'unmoderated': 'unmoderated'
};

// Display labels for each filter option
const labelMap: Record<string, string> = {
  'all': 'All',
  'test': 'App Testing',
  'survey': 'Survey',
  'poll': 'Poll',
  'interview': 'Interview',
  'question': 'Question',
  'unmoderated': 'Unmoderated'
};

// Filter categories in display order
const categories = ['all', 'test', 'unmoderated', 'survey', 'poll', 'interview', 'question'];

const StudyFilters: React.FC<StudyFiltersProps> = ({ currentFilter, onFilterChange }) => {
  return (
    <div 
      className="study-filters-container" 
      role="group" 
      aria-label="Filter by study type"
    >
      {categories.map((category) => {
        const isActive = currentFilter === category;
        const cssModifier = category === 'all' ? 'all' : (styleMap[category] || category);
        
        return (
          <button
            key={category}
            type="button"
            className={`filter-chip filter-chip--${cssModifier}${isActive ? ' is-active' : ''}`}
            onClick={() => onFilterChange(category)}
            aria-pressed={isActive}
          >
            {labelMap[category] || category}
          </button>
        );
      })}
    </div>
  );
};

export default StudyFilters;

