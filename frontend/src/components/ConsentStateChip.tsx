import React from 'react';

import { isCustomConsentTemplate } from '@shared/firsthand/consent-templates';

interface ConsentStateChipProps {
  /** The study's stored classification. Null or absent means never established. */
  templateId?: string | null;
}

/**
 * Whether a study runs on approved consent wording, at a glance, in a list.
 *
 * Deliberately says nothing when the answer is "yes". A badge on every row
 * would put the same word beside every study and stop being read within a
 * screenful, which is the failure mode of every status column that reports the
 * expected case; the whole value here is that the exception is visible. So the
 * approved case renders nothing, and the exception renders a word.
 *
 * "Custom consent" and not "unapproved consent", because the second reads as an
 * accusation and the researcher who set it did so deliberately and was told at
 * the time that it would be recorded. The point is to make the deviation
 * findable, not to tell somebody off in a list.
 *
 * Not colour alone: the word IS the signal, and the styling only reinforces it.
 */
const ConsentStateChip: React.FC<ConsentStateChipProps> = ({ templateId }) => {
  if (!isCustomConsentTemplate(templateId)) {
    return null;
  }

  return (
    <span
      className="badge bg-warning text-dark"
      data-testid="consent-state-chip"
      title="This study does not use the approved consent wording."
    >
      Custom consent
    </span>
  );
};

export default ConsentStateChip;
