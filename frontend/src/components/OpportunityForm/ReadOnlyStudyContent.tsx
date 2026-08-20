import React from 'react';

interface ReadOnlyStudyContentProps {
  /** The hydrated items, in order. Only the prompt is shown. */
  items: readonly { prompt: string }[];
  /** `question` / `task`, singular, lower case. */
  noun: string;
}

/**
 * What a study the author may not edit here looks like.
 *
 * Before B3 this surface showed the reuse PICKER instead, because read-only and
 * "reuse an existing one" were the same branch: the only thing offered to an
 * author who could not edit the linked study was the chance to link a different
 * one. With linking gone there is no picker to fall back to, and showing
 * nothing would be worse than what it replaced - so the content is shown, and
 * shown plainly, as text rather than as disabled inputs.
 *
 * Disabled inputs were the obvious alternative and are the wrong one: a
 * disabled textarea still reads as an editing surface that happens to be
 * switched off, and invites the author to look for what would switch it back
 * on. A list says what it is.
 */
const ReadOnlyStudyContent: React.FC<ReadOnlyStudyContentProps> = ({ items, noun }) => {
  if (items.length === 0) {
    return (
      <p className="text-muted" style={{ fontSize: '0.9rem' }}>
        There is nothing to show for this {noun} list.
      </p>
    );
  }

  return (
    <ol className="ps-3" data-testid="read-only-study-content">
      {items.map((item, index) => (
        <li key={index} className="mb-2">
          {item.prompt || <span className="text-muted">Empty {noun}</span>}
        </li>
      ))}
    </ol>
  );
};

export default ReadOnlyStudyContent;
