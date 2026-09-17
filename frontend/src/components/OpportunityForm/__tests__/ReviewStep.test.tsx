import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import ReviewStep from '../ReviewStep';
import type { ReviewSection } from '../../../lib/opportunity-authoring/review-summary';

/**
 * #111: Status moved off Basic Information and onto this step, as a live
 * control rather than a read-only summary row - and #108 put the participant
 * share link directly beneath it.
 *
 * `review-summary.test.ts` has its own note on why "Status" no longer
 * appears there; this file is where the equivalent coverage lives now that
 * the control has moved.
 *
 * Sections are unit-tested in `review-summary.test.ts`. This file supplies
 * only enough of a section to prove the summary itself still renders and
 * that an Edit link opens the right step - the content of a section is not
 * this component's business (see the file-level comment in `ReviewStep.tsx`).
 */

const SECTION: ReviewSection = {
  stepId: 1,
  stepKey: 'basics',
  title: 'Basic Information',
  focusFieldId: 'title',
  items: [
    { label: 'Title', value: 'A study about checkout' },
    { label: 'Purpose', value: 'Find where people stall', missing: false }
  ]
};

const baseProps = {
  sections: [SECTION],
  // Deliberately distinct from the SECTION's Title value above, so a test that
  // reads the header title cannot accidentally match the section row instead.
  header: { title: 'Checkout research study', typeLabel: 'Survey' },
  publishRefusal: null,
  onEdit: vi.fn(),
  isEdit: false,
  status: 'draft' as const,
  onStatusChange: vi.fn(),
  shareLink: null
};

describe('ReviewStep - the summary', () => {
  it('renders one card per section, with its own Edit link', () => {
    render(<ReviewStep {...baseProps} />);

    expect(screen.getByRole('heading', { name: 'Basic Information' })).toBeInTheDocument();
    expect(screen.getByText('A study about checkout')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Edit Basic Information' }));
    expect(baseProps.onEdit).toHaveBeenCalledWith(1, 'title');
  });

  it('says nothing has been saved yet when creating', () => {
    render(<ReviewStep {...baseProps} isEdit={false} />);
    expect(screen.getByText(/Nothing has been saved yet/i)).toBeInTheDocument();
  });

  it('says to check before saving when editing, not that nothing is saved', () => {
    render(<ReviewStep {...baseProps} isEdit />);
    expect(screen.getByText(/Check everything before you save/i)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing has been saved yet/i)).not.toBeInTheDocument();
  });

  /**
   * Row 16: "Any change you have not already saved is still only on this
   * screen" is false on an autosaving draft, where the timer has already
   * persisted every settled change. Pinned per save model.
   */
  describe('the standfirst, pinned per save model (row 16)', () => {
    it('says changes save automatically on an autosaving draft edit', () => {
      render(<ReviewStep {...baseProps} isEdit status="draft" />);
      expect(
        screen.getByText(/Changes on this screen are saved automatically as you go/i)
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/still only on this screen/i)
      ).not.toBeInTheDocument();
    });

    it('keeps the "still only on this screen" claim for a published edit, where autosave does not run', () => {
      render(<ReviewStep {...baseProps} isEdit status="published" />);
      expect(
        screen.getByText(/Any change you have not already saved is still only on this screen/i)
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/saved automatically/i)
      ).not.toBeInTheDocument();
    });
  });

  it('marks a missing value with an icon, never with colour alone', () => {
    const flagged: ReviewSection = {
      ...SECTION,
      items: [{ label: 'External Link', value: 'javascript:alert(1)', missing: true }]
    };
    render(<ReviewStep {...baseProps} sections={[flagged]} />);

    const value = screen.getByText('javascript:alert(1)').closest('dd')!;
    expect(value).toHaveClass('validation-error');
    expect(value.querySelector('svg')).not.toBeNull();
  });

  it('lays each section out as a two-column description list', () => {
    render(<ReviewStep {...baseProps} />);

    // The label and its value both still render, and the pair sits in the
    // two-column grid rather than the old stacked list.
    const label = screen.getByText('Purpose');
    const dl = label.closest('dl')!;
    expect(dl).toHaveClass('review-dl');
    expect(within(dl).getByText('Find where people stall')).toBeInTheDocument();
  });

  /**
   * Row 30: sections read as a rule + title, not one more bordered card, and
   * the Edit control shows the fixed word "Edit" rather than "Edit {title}" -
   * so every one sits at the same x position - while the full accessible
   * name still exists for a screen reader (and for `getByRole`, proven
   * above).
   */
  it('lays a section out as a rule and title, with a short visible Edit label', () => {
    render(<ReviewStep {...baseProps} />);

    const heading = screen.getByRole('heading', { name: 'Basic Information' });
    expect(heading.closest('section')).toHaveClass('review-section');

    const edit = screen.getByRole('button', { name: 'Edit Basic Information' });
    expect(edit).toHaveTextContent('Edit');
    expect(edit).not.toHaveTextContent('Edit Basic Information');
  });
});

/**
 * Row 30: Review's own H2 was the one step heading missing the inline
 * `fontSize: '1.5rem'` every other step's heading carries
 * (`BasicInfoTab.tsx`, `ScreenerStep.tsx`, and the rest), so it
 * rendered 13px against their 18px.
 */
describe('ReviewStep - the H2 matches the other step headings (row 30)', () => {
  it('gives the Review heading the same 1.5rem size the other steps use', () => {
    render(<ReviewStep {...baseProps} />);

    const heading = screen.getByRole('heading', { name: 'Review', level: 2 });
    expect(heading).toHaveStyle({ fontSize: '1.5rem' });
  });
});

describe('ReviewStep - the identity header (WZ-17)', () => {
  it('leads with the study title and a type pill', () => {
    render(<ReviewStep {...baseProps} />);

    const header = screen.getByTestId('review-header');
    expect(within(header).getByRole('heading', { name: 'Checkout research study' }))
      .toBeInTheDocument();
    expect(within(header).getByText('Survey')).toBeInTheDocument();
  });

  it('shows a Draft pill with a warning icon when the status is draft', () => {
    render(<ReviewStep {...baseProps} status="draft" />);

    const header = screen.getByTestId('review-header');
    const draft = within(header).getByText('Draft');
    // Never colour alone: the draft pill carries the AlertTriangle icon too.
    expect(draft.closest('span')!.querySelector('svg')).not.toBeNull();
    expect(within(header).queryByText('Published')).not.toBeInTheDocument();
  });

  it('shows a neutral Published pill when the status is published', () => {
    render(<ReviewStep {...baseProps} status="published" />);

    const header = screen.getByTestId('review-header');
    expect(within(header).getByText('Published')).toBeInTheDocument();
    expect(within(header).queryByText('Draft')).not.toBeInTheDocument();
  });

  it('shows "Published, not working" instead of Published when a publish blocker exists (row 6)', () => {
    render(
      <ReviewStep
        {...baseProps}
        status="published"
        publishRefusal={{
          message: 'Add questions before publishing.',
          stepId: 2,
          stepTitle: 'Questions'
        }}
      />
    );

    const header = screen.getByTestId('review-header');
    expect(within(header).getByText('Published, not working')).toBeInTheDocument();
    expect(within(header).queryByText('Published')).not.toBeInTheDocument();
  });

  it('also reads "Published, not working" from a non-empty checklist, with no singular refusal', () => {
    render(
      <ReviewStep
        {...baseProps}
        status="published"
        publishRefusal={null}
        publishProblems={[
          { message: 'Add questions before publishing.', stepId: 2, stepTitle: 'Questions' }
        ]}
      />
    );

    const header = screen.getByTestId('review-header');
    expect(within(header).getByText('Published, not working')).toBeInTheDocument();
  });

  it('flags a missing title as a problem, never by colour alone, when none is entered', () => {
    render(<ReviewStep {...baseProps} header={{ title: '', typeLabel: 'Not chosen' }} />);

    const header = screen.getByTestId('review-header');
    const heading = within(header).getByRole('heading');
    // The word says it is a required field short of a value, not a placeholder.
    expect(heading).toHaveTextContent(/No title yet/i);
    // The shared missing-value colour (validation-error) - the same channel
    // every other missing value on this screen uses.
    expect(heading).toHaveClass('validation-error');
    // And an icon, so the state survives greyscale and being read aloud.
    expect(heading.querySelector('svg')).not.toBeNull();
    expect(within(header).getByText('Not chosen')).toBeInTheDocument();
  });
});

describe('ReviewStep - the publish refusal preview', () => {
  it('shows nothing when there is no refusal', () => {
    render(<ReviewStep {...baseProps} publishRefusal={null} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('names the offending step and links to it, without disabling anything', () => {
    const onEdit = vi.fn();
    render(
      <ReviewStep
        {...baseProps}
        onEdit={onEdit}
        publishRefusal={{
          message: 'Add an external link before publishing a poll.',
          stepId: 3,
          stepTitle: 'External Link'
        }}
      />
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Add an external link before publishing a poll.');
    const link = within(alert).getByRole('button', { name: 'Go to External Link' });
    expect(link).toBeEnabled();

    fireEvent.click(link);
    expect(onEdit).toHaveBeenCalledWith(3);
  });
});

/**
 * Row 4: a moderated study missing both its venue and its slots must be
 * told about BOTH, not just whichever one `findPublishProblem` (singular)
 * happens to check first. `publishProblems` is the additive prop that
 * carries every unmet requirement; see this file's own note on why
 * `OpportunityForm.tsx` does not build it yet.
 */
describe('ReviewStep - the publish problem checklist (row 4)', () => {
  it('a draft Review lists the problems as a checklist', () => {
    const onEdit = vi.fn();
    render(
      <ReviewStep
        {...baseProps}
        isEdit
        status="draft"
        onEdit={onEdit}
        publishProblems={[
          {
            message: 'Enter where the session takes place before publishing.',
            stepId: 1,
            stepTitle: 'Basic Information'
          },
          {
            message: 'Add at least one upcoming time slot before publishing.',
            stepId: 3,
            stepTitle: 'Session Management'
          }
        ]}
      />
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(
      'Enter where the session takes place before publishing.'
    );
    expect(alert).toHaveTextContent(
      'Add at least one upcoming time slot before publishing.'
    );
    // Both, as separate list items, not concatenated into one sentence.
    expect(within(alert).getAllByRole('listitem')).toHaveLength(2);

    fireEvent.click(within(alert).getByRole('button', { name: 'Go to Session Management' }));
    expect(onEdit).toHaveBeenCalledWith(3);
  });

  it('falls back to the single publishRefusal alert when the checklist is empty', () => {
    render(
      <ReviewStep
        {...baseProps}
        publishProblems={[]}
        publishRefusal={{
          message: 'Add an external link before publishing a poll.',
          stepId: 3,
          stepTitle: 'External Link'
        }}
      />
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Add an external link before publishing a poll.');
    expect(within(alert).queryAllByRole('listitem')).toHaveLength(0);
  });

  it('prefers the checklist over the singular refusal when both are given', () => {
    render(
      <ReviewStep
        {...baseProps}
        publishRefusal={{
          message: 'The singular message, which should not appear.',
          stepId: 1,
          stepTitle: 'Basic Information'
        }}
        publishProblems={[
          { message: 'The checklist message.', stepId: 3, stepTitle: 'External Link' }
        ]}
      />
    );

    expect(screen.getByRole('alert')).toHaveTextContent('The checklist message.');
    expect(screen.queryByText('The singular message, which should not appear.')).not.toBeInTheDocument();
  });
});

describe('ReviewStep - Status (#111)', () => {
  /**
   * Review's Status control has no `<label htmlFor="status">` - only an
   * `<h3>Status</h3>` heading - so every query below finds it by role,
   * scoped to this step, rather than by an accessible name. Pinned here as
   * documentation of a real gap: the control used to be labelled on Basic
   * Information (`git show 1b744f5 -- BasicInfoTab.tsx`), and the move
   * dropped that association.
   */
  const statusControl = () => screen.getByRole('combobox') as HTMLSelectElement;

  it('defaults to draft and says so in a full sentence', () => {
    render(<ReviewStep {...baseProps} status="draft" />);
    expect(statusControl().value).toBe('draft');
    expect(screen.getByText(/DRAFT/)).toHaveTextContent(
      /Not visible to users\. Change to Published to make visible\./
    );
  });

  it('describes published in a full sentence too, once chosen', () => {
    render(<ReviewStep {...baseProps} status="published" />);
    expect(statusControl().value).toBe('published');
    expect(
      screen.getByText('Published studies are visible to all users')
    ).toBeInTheDocument();
    // The draft warning is gone, not merely joined by the published one.
    expect(screen.queryByText(/DRAFT/)).not.toBeInTheDocument();
  });

  it('calls onStatusChange with the chosen value, and nothing else', () => {
    const onStatusChange = vi.fn();
    render(<ReviewStep {...baseProps} onStatusChange={onStatusChange} />);

    fireEvent.change(statusControl(), { target: { value: 'published' } });

    expect(onStatusChange).toHaveBeenCalledTimes(1);
    expect(onStatusChange).toHaveBeenCalledWith('published');
  });

  it('shows a field error beside the control, and marks it invalid', () => {
    render(<ReviewStep {...baseProps} statusError="Choose a status" />);
    expect(screen.getByText('Choose a status')).toBeInTheDocument();
    expect(statusControl()).toHaveAttribute('aria-invalid', 'true');
  });

  it('is not marked invalid when there is no error', () => {
    render(<ReviewStep {...baseProps} />);
    expect(statusControl()).toHaveAttribute('aria-invalid', 'false');
  });
});

describe('ReviewStep - the participant share link (#108)', () => {
  it('renders nothing share-related before the opportunity has an id', () => {
    render(<ReviewStep {...baseProps} shareLink={null} status="published" />);

    expect(screen.queryByText('Share this study')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Share this study' })).not.toBeInTheDocument();
  });

  it('shows a draft hint, with no URL and no copy button, once an id exists', () => {
    render(
      <ReviewStep
        {...baseProps}
        status="draft"
        shareLink={{ opportunityId: 'opp-1', startable: true }}
      />
    );

    expect(screen.getByText('Share this study')).toBeInTheDocument();
    expect(
      screen.getByText(/Publish to share this link/i)
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy link' })).not.toBeInTheDocument();
    expect(screen.queryByText(new RegExp(`/opportunities/opp-1`))).not.toBeInTheDocument();
  });

  it('renders the live ShareOpportunityLink once published, with the role and startable flag passed through', () => {
    render(
      <ReviewStep
        {...baseProps}
        status="published"
        role="researcher_admin"
        shareLink={{ opportunityId: 'opp-1', startable: true }}
      />
    );

    // ShareOpportunityLink's own suite covers its content in full; this
    // proves ReviewStep actually mounts it, with the right props, rather
    // than the draft hint.
    expect(
      screen.getByText(`${window.location.origin}/opportunities/opp-1`)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
    expect(screen.queryByText(/Publish to share this link/i)).not.toBeInTheDocument();
  });

  it('warns inside the live link when the study is published but not startable', () => {
    render(
      <ReviewStep
        {...baseProps}
        status="published"
        role="researcher_admin"
        shareLink={{ opportunityId: 'opp-1', startable: false }}
      />
    );

    expect(screen.getByText(/Participants cannot start this yet/i)).toBeInTheDocument();
  });

  it('does not render the live link for a non-admin role, even once published', () => {
    // ShareOpportunityLink's own admin gate - proven here to still apply
    // through ReviewStep's own pass-through rather than assumed.
    render(
      <ReviewStep
        {...baseProps}
        status="published"
        role="employee"
        shareLink={{ opportunityId: 'opp-1', startable: true }}
      />
    );

    expect(screen.queryByText('Share this study')).not.toBeInTheDocument();
  });
});
