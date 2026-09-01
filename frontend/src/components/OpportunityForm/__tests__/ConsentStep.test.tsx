import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import ConsentStep, { type ConsentSelection } from '../ConsentStep';
import {
  CUSTOM_CONSENT_TEMPLATE_ID,
  MODERATED_CONSENT_TEMPLATE,
  RECORDED_CONSENT_TEMPLATE,
  SURVEY_CONSENT_TEMPLATE
} from '@shared/firsthand/consent-templates';

const moderatedEmpty = {
  kind: 'moderated',
  consentText: '',
  templateId: CUSTOM_CONSENT_TEMPLATE_ID,
  templateVersion: null,
  fieldId: 'inline_moderated_consent_text',
  contentStepTitle: 'Task List'
} as const;

/**
 * The consent step, which is C1's whole point: the approved wording is the
 * default, it is protected from an accidental edit, and any deviation is
 * recorded and visible.
 *
 * `onChange` is asserted rather than the rendered text wherever the question is
 * "what would be SAVED", because what the step displays and what it would store
 * are exactly the two things this feature must not let drift apart.
 */
const renderStep = (
  overrides: Partial<React.ComponentProps<typeof ConsentStep>> = {}
) => {
  const onChange = vi.fn<(selection: ConsentSelection) => void>();
  const onGoToContent = vi.fn();

  const props: React.ComponentProps<typeof ConsentStep> = {
    kind: 'recorded',
    consentText: RECORDED_CONSENT_TEMPLATE.text,
    templateId: RECORDED_CONSENT_TEMPLATE.id,
    templateVersion: RECORDED_CONSENT_TEMPLATE.version,
    fieldId: 'inline_study_consent_text',
    studyIsReadOnly: false,
    readOnlyReason: null,
    contentUnavailable: false,
    awaitingContent: false,
    contentStepTitle: 'Task List',
    onGoToContent,
    onChange,
    ...overrides
  };

  const view = render(<ConsentStep {...props} />);

  return { onChange, onGoToContent, view, props };
};

describe('ConsentStep - locked by default', () => {
  it('shows the approved wording with its template named and its version', () => {
    renderStep();

    expect(screen.getByTestId('consent-template-state')).toHaveTextContent(
      'Standard recorded-session consent (version 1)'
    );
    expect(screen.getByTestId('consent-locked-text')).toHaveTextContent(
      RECORDED_CONSENT_TEMPLATE.text
    );
  });

  it('says what the wording covers, not only what it is called', () => {
    renderStep();

    expect(screen.getByTestId('consent-template-state')).toHaveTextContent(
      RECORDED_CONSENT_TEMPLATE.summary
    );
  });

  /**
   * Locked means there is nothing to type into, not a greyed-out box. A
   * disabled textarea reads as an editing surface that happens to be switched
   * off; asserting its ABSENCE is what keeps the distinction.
   */
  it('offers no editable field until the author asks for one', () => {
    renderStep();

    expect(screen.queryByLabelText(/Consent text/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Customise consent wording/i })
    ).toBeInTheDocument();
  });

  it('names the survey template for a survey, not the recorded one', () => {
    renderStep({
      kind: 'survey',
      consentText: SURVEY_CONSENT_TEMPLATE.text,
      templateId: SURVEY_CONSENT_TEMPLATE.id,
      templateVersion: SURVEY_CONSENT_TEMPLATE.version,
      fieldId: 'inline_survey_consent_text',
      contentStepTitle: 'Questions'
    });

    // The twin assertion. The two templates say opposite things about
    // recording, so a step that showed one family's name over the other's
    // wording would be describing a study as something it is not.
    expect(screen.getByTestId('consent-template-state')).toHaveTextContent(
      'Standard survey consent (version 1)'
    );
    expect(screen.getByTestId('consent-locked-text')).toHaveTextContent(
      /Nothing is recorded/i
    );
  });
});

describe('ConsentStep - the deliberate override', () => {
  it('unlocks the field without changing what would be saved', () => {
    const { onChange } = renderStep();

    fireEvent.click(
      screen.getByRole('button', { name: /Customise consent wording/i })
    );

    expect(screen.getByLabelText(/Consent text/i)).toBeInTheDocument();
    // Nothing saved yet. `custom` is set by DIVERGENCE, not by unlocking - an
    // author who opens the field, reads it and changes nothing is still running
    // on the approved template.
    expect(onChange).not.toHaveBeenCalled();
  });

  it('records custom the moment the wording actually diverges', () => {
    const { onChange } = renderStep();

    fireEvent.click(
      screen.getByRole('button', { name: /Customise consent wording/i })
    );
    fireEvent.change(screen.getByLabelText(/Consent text/i), {
      target: { value: `${RECORDED_CONSENT_TEMPLATE.text} We also share it with our client.` }
    });

    expect(onChange).toHaveBeenCalledWith({
      text: `${RECORDED_CONSENT_TEMPLATE.text} We also share it with our client.`,
      templateId: CUSTOM_CONSENT_TEMPLATE_ID,
      templateVersion: null
    });
  });

  it('keeps the template when an edit leaves the wording identical', () => {
    const { onChange } = renderStep();

    fireEvent.click(
      screen.getByRole('button', { name: /Customise consent wording/i })
    );
    // Retyping the same wording, whitespace and all - the exact case that must
    // not mark a study as running on unapproved consent.
    fireEvent.change(screen.getByLabelText(/Consent text/i), {
      target: { value: `  ${RECORDED_CONSENT_TEMPLATE.text}\n` }
    });

    expect(onChange).toHaveBeenCalledWith({
      text: `  ${RECORDED_CONSENT_TEMPLATE.text}\n`,
      templateId: RECORDED_CONSENT_TEMPLATE.id,
      templateVersion: 1
    });
  });

  it('warns, in words, that customised wording is not approved wording', () => {
    renderStep({
      consentText: 'Whatever this researcher decided to write',
      templateId: CUSTOM_CONSENT_TEMPLATE_ID,
      templateVersion: null
    });

    const state = screen.getByTestId('consent-template-state');
    expect(state).toHaveTextContent(/Custom wording/i);
    expect(state).toHaveTextContent(/does not run on approved consent wording/i);
  });

  it('opens already unlocked for a study that is already customised', () => {
    renderStep({
      consentText: 'Whatever this researcher decided to write',
      templateId: CUSTOM_CONSENT_TEMPLATE_ID,
      templateVersion: null
    });

    expect(screen.getByLabelText(/Consent text/i)).toHaveValue(
      'Whatever this researcher decided to write'
    );
  });

  it('never blocks the override', () => {
    renderStep();

    fireEvent.click(
      screen.getByRole('button', { name: /Customise consent wording/i })
    );

    expect(screen.getByLabelText(/Consent text/i)).not.toBeDisabled();
    expect(screen.getByLabelText(/Consent text/i)).not.toHaveAttribute('readonly');
  });
});

describe('ConsentStep - the diff', () => {
  it('shows what changed against the template it started from', () => {
    renderStep({
      consentText: RECORDED_CONSENT_TEMPLATE.text.replace(
        'the research team.',
        'the research team and our client.'
      ),
      templateId: CUSTOM_CONSENT_TEMPLATE_ID,
      templateVersion: null
    });

    const diff = screen.getByTestId('consent-diff');
    expect(diff).toHaveTextContent(/Compared with Standard recorded-session consent/i);
    // The sentence, not only the marked-up paragraph: strike-through and
    // underline reach nobody using a screen reader.
    expect(diff).toHaveTextContent(/words added compared with the approved wording/i);
    expect(diff.querySelector('ins')).not.toBeNull();
  });

  it('restores the exact approved wording, and the template with it', () => {
    const { onChange } = renderStep({
      consentText: 'Something else entirely',
      templateId: CUSTOM_CONSENT_TEMPLATE_ID,
      templateVersion: null
    });

    fireEvent.click(
      screen.getByRole('button', { name: /Restore the approved wording/i })
    );

    expect(onChange).toHaveBeenCalledWith({
      text: RECORDED_CONSENT_TEMPLATE.text,
      templateId: RECORDED_CONSENT_TEMPLATE.id,
      templateVersion: 1
    });
  });

  it('re-locks the field once the approved wording is restored', () => {
    renderStep({
      consentText: 'Something else entirely',
      templateId: CUSTOM_CONSENT_TEMPLATE_ID,
      templateVersion: null
    });

    expect(screen.getByLabelText(/Consent text/i)).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: /Restore the approved wording/i })
    );

    // Back to locked. Leaving the textarea open after a restore invites the
    // author to edit again without deciding to, which is the whole thing the
    // lock exists to stop.
    expect(screen.queryByLabelText(/Consent text/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Customise consent wording/i })
    ).toBeInTheDocument();
  });

  it('restores the survey template on a survey, not the recorded one', () => {
    const { onChange } = renderStep({
      kind: 'survey',
      consentText: 'Something else entirely',
      templateId: CUSTOM_CONSENT_TEMPLATE_ID,
      templateVersion: null,
      fieldId: 'inline_survey_consent_text',
      contentStepTitle: 'Questions'
    });

    fireEvent.click(
      screen.getByRole('button', { name: /Restore the approved wording/i })
    );

    expect(onChange).toHaveBeenCalledWith({
      text: SURVEY_CONSENT_TEMPLATE.text,
      templateId: SURVEY_CONSENT_TEMPLATE.id,
      templateVersion: 1
    });
  });
});

/**
 * The gating C1 is most likely to get wrong.
 *
 * Before C1, both consent textareas lived inside the third arm of
 * `studyIsReadOnly ? readOnly : showChooser ? picker : editor`, so neither
 * state could reach them. A step lifted out of that arm inherits none of it,
 * and would offer an editable consent field for a study the author may not
 * change, or for content they have not chosen yet.
 */
describe('ConsentStep - the states it must not offer an editor in', () => {
  it('shows a study it may not change as text, with no way to edit it', () => {
    renderStep({
      studyIsReadOnly: true,
      consentText: 'Another researcher wrote this',
      templateId: CUSTOM_CONSENT_TEMPLATE_ID,
      templateVersion: null
    });

    expect(screen.getByTestId('consent-read-only-text')).toHaveTextContent(
      'Another researcher wrote this'
    );
    expect(screen.queryByLabelText(/Consent text/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Customise consent wording/i })
    ).not.toBeInTheDocument();
  });

  it('still states the classification of a study it may not change', () => {
    renderStep({
      studyIsReadOnly: true,
      consentText: 'Another researcher wrote this',
      templateId: CUSTOM_CONSENT_TEMPLATE_ID,
      templateVersion: null
    });

    expect(screen.getByTestId('consent-template-state')).toHaveTextContent(
      /Custom wording/i
    );
  });

  it('refuses to author consent for content that has not been chosen yet', () => {
    const { onGoToContent } = renderStep({ awaitingContent: true });

    expect(screen.queryByLabelText(/Consent text/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('consent-locked-text')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Go back to Task List/i }));
    expect(onGoToContent).toHaveBeenCalled();
  });

  it('names the surface it sends the author back to, per vocabulary', () => {
    renderStep({
      kind: 'survey',
      awaitingContent: true,
      contentStepTitle: 'Questions',
      fieldId: 'inline_survey_consent_text'
    });

    expect(
      screen.getByRole('button', { name: /Go back to Questions/i })
    ).toBeInTheDocument();
  });

  /**
   * The precedence, asserted with BOTH flags set.
   *
   * The parent makes these mutually exclusive - `isAwaitingCopiedContent`
   * requires `!studyIsReadOnly` - so this state is unreachable through the app
   * today. It is asserted anyway because the component takes them as
   * independent props, and the previous version of this test set
   * `awaitingContent: false` and therefore proved nothing at all about
   * precedence while claiming to. Read-only is the stronger claim: "you may not
   * change this" outranks "you have not chosen content yet".
   */
  it('treats read-only as the stronger of the two, with both set', () => {
    renderStep({ studyIsReadOnly: true, awaitingContent: true });

    expect(screen.getByTestId('consent-read-only-text')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Go back to/i })).not.toBeInTheDocument();
  });

  /**
   * 🔥 The arm that would make the whole feature lie.
   *
   * When the linked study cannot be READ - any failure that is not a 404 - the
   * form keeps its DEFAULTS in state: `DEFAULT_CONSENT_TEXT` and the current
   * template id. It also sets read-only. Rendering the read-only arm in that
   * state showed the boilerplate under a "Standard recorded-session consent
   * (version 1)" badge, presented as this study's own wording - a positive
   * claim of approval for wording the app never fetched.
   */
  it('claims nothing at all when the study could not be read', () => {
    renderStep({
      contentUnavailable: true,
      studyIsReadOnly: true,
      consentText: RECORDED_CONSENT_TEMPLATE.text,
      templateId: RECORDED_CONSENT_TEMPLATE.id,
      templateVersion: 1
    });

    expect(screen.getByTestId('consent-unavailable')).toBeInTheDocument();
    // None of the three things that would assert something about this study.
    expect(screen.queryByTestId('consent-template-state')).not.toBeInTheDocument();
    expect(screen.queryByTestId('consent-read-only-text')).not.toBeInTheDocument();
    expect(screen.queryByTestId('consent-locked-text')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Consent text/i)).not.toBeInTheDocument();
  });

  it('outranks every other arm, because it is the only one that knows nothing', () => {
    renderStep({ contentUnavailable: true, awaitingContent: true, studyIsReadOnly: false });

    expect(screen.getByTestId('consent-unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Go back to/i })).not.toBeInTheDocument();
  });

  /**
   * A study can be read-only for two different reasons, and the sentence has to
   * match: `not-representable` is fixable in the Task Lists area, `not-yours`
   * is not. Telling an author their own study belongs to somebody else sends
   * them nowhere.
   */
  it('says WHY it is read-only, and the two reasons say different things', () => {
    const { view } = renderStep({
      studyIsReadOnly: true,
      readOnlyReason: 'not-yours',
      consentText: 'Someone else wrote this'
    });
    expect(screen.getByText(/not yours to change here/i)).toBeInTheDocument();
    expect(screen.queryByText(/Task Lists area/i)).not.toBeInTheDocument();

    view.unmount();

    renderStep({
      studyIsReadOnly: true,
      readOnlyReason: 'not-representable',
      consentText: 'Content this form cannot represent'
    });
    expect(screen.getByText(/Task Lists area/i)).toBeInTheDocument();
    expect(screen.queryByText(/not yours to change here/i)).not.toBeInTheDocument();
  });

  /**
   * The error summary routes by FIELD, and consent's field maps to this step -
   * so a refusal can land the author on the awaiting arm. Rendering nothing
   * there gives them a banner naming "Consent text" on a step with no consent
   * text on it and no clue why.
   *
   * Reachable without any tooling: author consent, clear it, go back and switch
   * the source choice to "start from an existing study", save.
   */
  it('shows the refusal even on the arm that has no field to show', () => {
    renderStep({ awaitingContent: true, validationError: 'Consent text is required' });

    expect(screen.getByRole('alert')).toHaveTextContent('Consent text is required');
    expect(screen.getByRole('button', { name: /Go back to Task List/i })).toBeInTheDocument();
  });
});

describe('ConsentStep - the badge never asserts more than the row records', () => {
  it('prints a version number only when that version was actually published', () => {
    renderStep({ templateVersion: 1 });
    expect(screen.getByTestId('consent-template-state')).toHaveTextContent(
      '(version 1)'
    );
  });

  it('names the template but not a version when the stored version is unknown', () => {
    // Reachable on a rollback after a v2: the row carries version 2, the code
    // serving it knows only version 1. Falling back to "the current version"
    // would print "(version 1)" for a row that says 2 - inventing a specific
    // approval nothing recorded.
    renderStep({ templateVersion: 2 });

    const state = screen.getByTestId('consent-template-state');
    expect(state).toHaveTextContent('Standard recorded-session consent');
    expect(state).toHaveTextContent('(version not recorded)');
    expect(state).not.toHaveTextContent('(version 1)');
  });

  it('refuses a template belonging to the other kind', () => {
    // A recorded study carrying `survey-default` must not be badged with
    // wording whose central claim - that nothing is recorded - is false of it.
    renderStep({
      kind: 'recorded',
      templateId: SURVEY_CONSENT_TEMPLATE.id,
      templateVersion: 1
    });

    expect(screen.getByTestId('consent-template-state')).toHaveTextContent(
      /Custom wording/i
    );
  });
});

/**
 * cto/AdaptaLabs#100. Emptying moderated consent is the author saying "this
 * session stores nothing, no consent is asked at booking" - the save sends
 * consent_text: null. But empty text resolves to `custom` (it matches no
 * template), so the step used to accuse the author of an unapproved deviation
 * while they did the sanctioned thing. Empty is a THIRD state, distinct from
 * both "approved template" and "custom deviation", and only moderated has it -
 * the study kinds' consent is required.
 */
describe('ConsentStep - the empty moderated "no consent asked" state (#100)', () => {
  it('badge says no consent is asked, not that custom wording is recorded against it', () => {
    renderStep(moderatedEmpty);

    const state = screen.getByTestId('consent-template-state');
    expect(state).toHaveTextContent(/no consent/i);
    expect(state).not.toHaveTextContent(/recorded against it/i);
    expect(state).not.toHaveTextContent(/Custom wording/i);
  });

  it('help text explains that empty means no consent, not an unapproved deviation', () => {
    renderStep(moderatedEmpty);

    // Empty moderated opens unlocked (templateId is custom), so the field and
    // its help text are on screen without a click.
    const help = screen.getByText(/no consent/i, { selector: '.form-text' });
    expect(help).toBeInTheDocument();
    expect(
      screen.queryByText(/has not been approved/i)
    ).not.toBeInTheDocument();
  });

  it('shows no diff when there is no wording to compare against', () => {
    renderStep(moderatedEmpty);

    expect(screen.queryByTestId('consent-diff')).not.toBeInTheDocument();
  });

  it('states no-consent for a read-only moderated study that stores nothing', () => {
    renderStep({
      ...moderatedEmpty,
      studyIsReadOnly: true,
      readOnlyReason: 'not-yours'
    });

    expect(screen.getByTestId('consent-template-state')).toHaveTextContent(
      /no consent/i
    );
    // No empty blockquote passed off as this study's wording.
    expect(
      screen.queryByTestId('consent-read-only-text')
    ).not.toBeInTheDocument();
  });

  /**
   * The control. A STUDY KIND with empty text is not "no consent asked" - its
   * consent is required, so empty is an unfilled/custom state, not the third
   * state. This is what keeps the new branch scoped to moderated; without it,
   * `kind !== undefined && empty` would pass just as well.
   */
  it('does NOT treat empty as no-consent for a study kind, whose consent is required', () => {
    renderStep({
      kind: 'recorded',
      consentText: '',
      templateId: CUSTOM_CONSENT_TEMPLATE_ID,
      templateVersion: null,
      validationError: 'Consent text is required'
    });

    const state = screen.getByTestId('consent-template-state');
    expect(state).not.toHaveTextContent(/no consent is asked/i);
    expect(state).toHaveTextContent(/Custom wording/i);
  });
});

describe('ConsentStep - validation', () => {
  it('shows the refusal against the field the error names', () => {
    renderStep({
      consentText: '   ',
      templateId: CUSTOM_CONSENT_TEMPLATE_ID,
      templateVersion: null,
      validationError: 'Consent text is required'
    });

    expect(screen.getByRole('alert')).toHaveTextContent('Consent text is required');
    expect(screen.getByLabelText(/Consent text/i)).toHaveClass('is-invalid');
  });

  /**
   * The label's asterisk is a claim about the validator, asserted per kind
   * and BY NAME - a single test covering two renders left survey pinned by
   * nothing, so `kind === 'moderated' || kind === 'survey'` would have
   * survived it. Moderated consent (#79) is optional - clearing it means
   * "this session stores nothing, no consent is asked at booking" and only
   * length is validated - so its label must not mark the field required,
   * while the study kinds' consent is required once there is content.
   * Exact-match queries, because the substring regex the other tests use
   * cannot see the asterisk at all; `aria-required` asserted alongside, so
   * the rule reaches the accessibility tree and not only sighted readers.
   */
  it.each([
    ['recorded', 'Consent text *', 'true', RECORDED_CONSENT_TEMPLATE],
    ['survey', 'Consent text *', 'true', SURVEY_CONSENT_TEMPLATE],
    ['moderated', 'Consent text', 'false', MODERATED_CONSENT_TEMPLATE]
  ] as const)(
    'labels the %s consent field "%s"',
    (kind, label, ariaRequired, template) => {
      renderStep({
        kind,
        consentText: template.text,
        templateId: template.id,
        templateVersion: template.version,
        fieldId: `${kind}_consent_text`,
        contentStepTitle: 'Content'
      });

      fireEvent.click(
        screen.getByRole('button', { name: /Customise consent wording/i })
      );

      const textarea = screen.getByLabelText(label);
      expect(textarea).toHaveAttribute('aria-required', ariaRequired);
      expect(
        screen.queryByLabelText(
          kind === 'moderated' ? 'Consent text *' : 'Consent text'
        )
      ).not.toBeInTheDocument();
    }
  );

  it('uses the state key as the control id, so error routing can reach it', () => {
    renderStep({
      consentText: 'custom',
      templateId: CUSTOM_CONSENT_TEMPLATE_ID,
      templateVersion: null,
      fieldId: 'inline_survey_consent_text'
    });

    expect(screen.getByLabelText(/Consent text/i)).toHaveAttribute(
      'id',
      'inline_survey_consent_text'
    );
  });
});
