import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import ReadOnlyStudyContent from '../ReadOnlyStudyContent';

/** Three items so a `.slice(0, 1)` truncation is visible, not just a shorter list. */
const THREE_ITEMS = [
  { prompt: 'What slows you down?' },
  { prompt: 'How happy are you with checkout?' },
  { prompt: 'Anything else you would change?' }
];

describe('showing what is actually in a read-only set', () => {
  it('lists every item, in order', () => {
    render(<ReadOnlyStudyContent items={THREE_ITEMS} noun="question" />);

    const list = screen.getByTestId('read-only-study-content');
    const rendered = within(list)
      .getAllByRole('listitem')
      .map((item) => item.textContent);

    expect(rendered).toEqual([
      'What slows you down?',
      'How happy are you with checkout?',
      'Anything else you would change?'
    ]);
  });

  it('says there is nothing to show when the list is empty', () => {
    render(<ReadOnlyStudyContent items={[]} noun="question" />);

    expect(
      screen.getByText('There is nothing to show for this question list.')
    ).toBeInTheDocument();
    expect(screen.queryByTestId('read-only-study-content')).not.toBeInTheDocument();
  });

  it('placeholds a blank prompt rather than rendering an empty line', () => {
    render(
      <ReadOnlyStudyContent
        items={[{ prompt: 'What slows you down?' }, { prompt: '' }]}
        noun="question"
      />
    );

    expect(screen.getByText('Empty question')).toBeInTheDocument();
    expect(screen.getByText('What slows you down?')).toBeInTheDocument();
  });
});
