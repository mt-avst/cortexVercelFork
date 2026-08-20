import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import ConsentStateChip from '../ConsentStateChip';

/**
 * The at-a-glance answer in a list: which studies are NOT on approved consent
 * wording.
 *
 * It deliberately says nothing for the approved case. A badge on every row is a
 * badge nobody reads by the second screenful, and the exception is the whole
 * point - so "renders nothing" is a behaviour under test, not an omission.
 */
describe('ConsentStateChip', () => {
  it.each([
    ['recorded-default'],
    ['survey-default']
  ])('says nothing for %s, because approved is the expected case', (templateId) => {
    const { container } = render(<ConsentStateChip templateId={templateId} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('marks custom wording', () => {
    render(<ConsentStateChip templateId="custom" />);

    expect(screen.getByTestId('consent-state-chip')).toHaveTextContent(
      'Custom consent'
    );
  });

  /**
   * A study whose provenance was never established has not been approved, and a
   * list that stayed silent about it would show it as indistinguishable from an
   * approved one - which is worse than the badge being slightly over-eager.
   */
  it.each([[null], [undefined], ['']])(
    'marks a study with no recorded classification (%s)',
    (templateId) => {
      render(<ConsentStateChip templateId={templateId as string | null} />);

      expect(screen.getByTestId('consent-state-chip')).toBeInTheDocument();
    }
  );

  it('marks an id it does not recognise, rather than trusting it', () => {
    render(<ConsentStateChip templateId="some-template-invented-later" />);

    expect(screen.getByTestId('consent-state-chip')).toBeInTheDocument();
  });

  it('carries the meaning in words, not only in colour', () => {
    render(<ConsentStateChip templateId="custom" />);

    // The class could be swapped for any other and the row would still say what
    // it means. That is the requirement; the colour only reinforces it.
    expect(screen.getByTestId('consent-state-chip').textContent).toMatch(
      /custom consent/i
    );
  });
});
