import { describe, expect, it } from 'vitest';

import {
  buildReviewSummary,
  hostnameOf,
  stepForPublishProblem,
  type ReviewStepRef,
  type ReviewSummaryInput
} from './review-summary';

/**
 * The check-answers screen, pinned against the step LIST rather than the
 * type. Every fixture below uses a step list whose `id`s deliberately do not
 * equal `index + 1` wherever the assertion cares about `stepId` - on the
 * common shape (`id === index + 1`) a function that reads the step's
 * POSITION instead of its `id` behaves identically, and a test built on that
 * shape records a kill it has not earned.
 */

const completeInput = (
  overrides: Partial<ReviewSummaryInput> = {}
): ReviewSummaryInput => ({
  steps: [
    { id: 1, key: 'basics', title: 'Basic Information' },
    { id: 2, key: 'content', title: 'Content Details' },
    { id: 5, key: 'review', title: 'Review' }
  ],
  type: 'test',
  title: 'Onboarding walkthrough',
  purpose: 'Understand first-run confusion',
  status: 'draft',
  description: 'A short usability session on the new onboarding flow.',
  product: 'Cortex',
  meetingLocation: 'Zoom',
  defaultDurationMinutes: 30,
  participantType: 'any',
  participantTypeDetails: '',
  startDate: '',
  endDate: '',
  externalLink: '',
  deliveryMode: 'native',
  questionCount: 0,
  taskCount: 0,
  estimatedMinutes: null,
  targetUrl: '',
  consentText: '',
  consentTemplate: null,
  copiedFromStudyId: '',
  copiedFromStudyTitle: '',
  linkedStudyId: '',
  sessionCount: 0,
  ...overrides
});

/** A sparse, non-sequential step list covering every key this module handles. */
const allKeysSteps: ReviewStepRef[] = [
  { id: 1, key: 'basics', title: 'Basic Information' },
  { id: 2, key: 'content', title: 'Content Details' },
  { id: 3, key: 'questions', title: 'Questions' },
  { id: 9, key: 'taskList', title: 'Task List' },
  // 11 and 12: values no array index in this list can produce. `externalLink`
  // previously sat at index 4 carrying id 4, so an assertion on its `stepId`
  // would have passed under an implementation reading POSITION - the exact
  // coincidence this fixture exists to defeat, still present inside it.
  { id: 11, key: 'externalLink', title: 'External Link' },
  { id: 12, key: 'consent', title: 'Consent' },
  { id: 5, key: 'review', title: 'Review' }
];

const findSection = (
  sections: ReturnType<typeof buildReviewSummary>,
  key: string
) => sections.find((section) => section.stepKey === key);

const findItem = (
  section: ReturnType<typeof buildReviewSummary>[number] | undefined,
  label: string
) => section?.items.find((item) => item.label === label);

describe('buildReviewSummary', () => {
  it('never produces a section for Review itself', () => {
    const sections = buildReviewSummary(completeInput());
    expect(sections.some((section) => section.stepKey === 'review')).toBe(false);
    // The fixture has two real steps ahead of Review - both must survive, not
    // just the first.
    expect(sections).toHaveLength(2);
  });

  it('reads stepId from the step, not from its position in the list', () => {
    // taskList sits at index 3 of a 7-item list but carries id 9. A function
    // that used the index would report stepId 3.
    const sections = buildReviewSummary(
      completeInput({ steps: allKeysSteps, taskCount: 1 })
    );
    const taskList = findSection(sections, 'taskList');
    expect(taskList?.stepId).toBe(9);
    expect(taskList?.title).toBe('Task List');

    // 11, at index 4. The previous value here was 4 AT INDEX 4 - which an
    // implementation reading position would have satisfied, inside the very
    // test written to catch one.
    const externalLink = findSection(sections, 'externalLink');
    expect(externalLink?.stepId).toBe(11);

    // And the consent twin, at 12, so neither of the two ids this fixture
    // duplicated is left unasserted.
    expect(findSection(sections, 'consent')?.stepId).toBe(12);
  });

  describe('basics section', () => {
    it.each([
      ['test', 'Usability Test'],
      ['interview', 'Interview'],
      ['poll', 'Poll'],
      ['survey', 'Survey'],
      ['question', 'Question'],
      ['unmoderated', 'Unmoderated Test']
    ])('labels type %s as %s', (type, label) => {
      const sections = buildReviewSummary(completeInput({ type }));
      const basics = findSection(sections, 'basics');
      expect(findItem(basics, 'Research Study Type')?.value).toBe(label);
      expect(findItem(basics, 'Research Study Type')?.missing).toBeFalsy();
    });

    it('marks an unchosen type as missing, with "Not chosen"', () => {
      const sections = buildReviewSummary(completeInput({ type: '' }));
      const item = findItem(findSection(sections, 'basics'), 'Research Study Type');
      expect(item?.value).toBe('Not chosen');
      expect(item?.missing).toBe(true);
    });

    it('describes draft and published status in full sentences', () => {
      const draft = findItem(
        findSection(buildReviewSummary(completeInput({ status: 'draft' })), 'basics'),
        'Status'
      );
      const published = findItem(
        findSection(
          buildReviewSummary(completeInput({ status: 'published' })),
          'basics'
        ),
        'Status'
      );
      expect(draft?.value).toBe('Draft — not visible to participants');
      expect(published?.value).toBe('Published — visible to participants');
    });

    it('states a default duration only on the shapes that ask for one', () => {
      /*
       * Both halves, because either alone is satisfied by a bug. The row used
       * to be unconditional, so a poll's Review read "Default Duration 30
       * minutes" for a field the author never sees and the payload never
       * sends - `default_duration_minutes` goes only for test and interview.
       */
      const withSessions: ReviewStepRef[] = [
        { id: 1, key: 'basics', title: 'Basic Information' },
        { id: 2, key: 'content', title: 'Content Details' },
        { id: 6, key: 'sessions', title: 'Session Management' },
        { id: 5, key: 'review', title: 'Review' }
      ];
      const withoutSessions: ReviewStepRef[] = [
        { id: 1, key: 'basics', title: 'Basic Information' },
        { id: 2, key: 'content', title: 'Content Details' },
        { id: 7, key: 'externalLink', title: 'External Link' },
        { id: 5, key: 'review', title: 'Review' }
      ];

      const present = findItem(
        findSection(
          buildReviewSummary(
            completeInput({ steps: withSessions, defaultDurationMinutes: 45 })
          ),
          'basics'
        ),
        'Default Duration'
      );
      expect(present?.value).toBe('45 minutes');

      expect(
        findItem(
          findSection(
            buildReviewSummary(
              completeInput({ steps: withoutSessions, defaultDurationMinutes: 45 })
            ),
            'basics'
          ),
          'Default Duration'
        )
      ).toBeUndefined();
    });

    it('includes Meeting Location only when it is set, whatever the type', () => {
      const withLocation = findSection(
        buildReviewSummary(completeInput({ meetingLocation: 'Room 4' })),
        'basics'
      );
      const withoutLocation = findSection(
        buildReviewSummary(completeInput({ meetingLocation: '' })),
        'basics'
      );
      expect(findItem(withLocation, 'Meeting Location')?.value).toBe('Room 4');
      expect(findItem(withoutLocation, 'Meeting Location')).toBeUndefined();
    });

    it('includes Available from/until only when the dates are set', () => {
      const withDates = findSection(
        buildReviewSummary(
          completeInput({ startDate: '2026-09-01', endDate: '2026-09-30' })
        ),
        'basics'
      );
      const withoutDates = findSection(buildReviewSummary(completeInput()), 'basics');

      expect(findItem(withDates, 'Available from')?.value).toBe('2026-09-01');
      expect(findItem(withDates, 'Available until')?.value).toBe('2026-09-30');
      expect(findItem(withoutDates, 'Available from')).toBeUndefined();
      expect(findItem(withoutDates, 'Available until')).toBeUndefined();
    });
  });

  describe('content section', () => {
    const contentSteps: ReviewStepRef[] = [
      { id: 1, key: 'basics', title: 'Basic Information' },
      { id: 2, key: 'content', title: 'Content Details' },
      { id: 5, key: 'review', title: 'Review' }
    ];

    it('marks an empty description as missing', () => {
      const section = findSection(
        buildReviewSummary(completeInput({ steps: contentSteps, description: '' })),
        'content'
      );
      const item = findItem(section, 'Description');
      expect(item?.missing).toBe(true);
      /*
       * Words, not an empty string. The renderer marks a missing row with an
       * `aria-hidden` icon plus the value - so an empty value produced a `<dd>`
       * holding a glyph and nothing else: silence to a screen reader, a bare
       * mark in greyscale. Every other missing state here already said
       * something; these four did not.
       */
      expect(item?.value).toBe('Not set');
    });

    it('includes Product only when it is non-empty', () => {
      const withProduct = findSection(
        buildReviewSummary(
          completeInput({ steps: contentSteps, product: 'Confluence' })
        ),
        'content'
      );
      const withoutProduct = findSection(
        buildReviewSummary(completeInput({ steps: contentSteps, product: '' })),
        'content'
      );
      expect(findItem(withProduct, 'Product')?.value).toBe('Confluence');
      expect(findItem(withoutProduct, 'Product')).toBeUndefined();
    });

    it.each([
      ['any', 'Any participant'],
      ['internal', 'Internal only'],
      ['external', 'External only'],
      ['specific', 'Specific criteria']
    ])('labels participant type %s as %s', (participantType, label) => {
      const section = findSection(
        buildReviewSummary(
          completeInput({ steps: contentSteps, participantType })
        ),
        'content'
      );
      expect(findItem(section, 'Participant Type')?.value).toBe(label);
    });

    it('includes Specific Criteria only when details are given', () => {
      const withDetails = findSection(
        buildReviewSummary(
          completeInput({
            steps: contentSteps,
            participantType: 'specific',
            participantTypeDetails: 'Must own a Jira licence'
          })
        ),
        'content'
      );
      const withoutDetails = findSection(
        buildReviewSummary(
          completeInput({ steps: contentSteps, participantTypeDetails: '' })
        ),
        'content'
      );
      expect(findItem(withDetails, 'Specific Criteria')?.value).toBe(
        'Must own a Jira licence'
      );
      expect(findItem(withoutDetails, 'Specific Criteria')).toBeUndefined();
    });
  });

  describe('singular and plural counts', () => {
    const surveySteps: ReviewStepRef[] = [
      { id: 1, key: 'basics', title: 'Basic Information' },
      { id: 3, key: 'questions', title: 'Questions' },
      { id: 5, key: 'review', title: 'Review' }
    ];
    const unmoderatedSteps: ReviewStepRef[] = [
      { id: 1, key: 'basics', title: 'Basic Information' },
      { id: 3, key: 'taskList', title: 'Task List' },
      { id: 5, key: 'review', title: 'Review' }
    ];
    const sessionSteps: ReviewStepRef[] = [
      { id: 1, key: 'basics', title: 'Basic Information' },
      { id: 3, key: 'sessions', title: 'Session Management' },
      { id: 5, key: 'review', title: 'Review' }
    ];

    it('reads "1 question" for one and "2 questions" for two', () => {
      const one = findItem(
        findSection(
          buildReviewSummary(completeInput({ steps: surveySteps, questionCount: 1 })),
          'questions'
        ),
        'Questions'
      );
      const two = findItem(
        findSection(
          buildReviewSummary(completeInput({ steps: surveySteps, questionCount: 2 })),
          'questions'
        ),
        'Questions'
      );
      expect(one?.value).toBe('1 question');
      expect(two?.value).toBe('2 questions');
      expect(one?.missing).toBeFalsy();
      expect(two?.missing).toBeFalsy();
    });

    it('reads "1 task" for one and "2 tasks" for two', () => {
      const one = findItem(
        findSection(
          buildReviewSummary(
            completeInput({ steps: unmoderatedSteps, taskCount: 1 })
          ),
          'taskList'
        ),
        'Tasks'
      );
      const two = findItem(
        findSection(
          buildReviewSummary(
            completeInput({ steps: unmoderatedSteps, taskCount: 2 })
          ),
          'taskList'
        ),
        'Tasks'
      );
      expect(one?.value).toBe('1 task');
      expect(two?.value).toBe('2 tasks');
    });

    it('reads "1 slot" for one and "2 slots" for two', () => {
      const one = findItem(
        findSection(
          buildReviewSummary(
            completeInput({ steps: sessionSteps, sessionCount: 1 })
          ),
          'sessions'
        ),
        'Time slots'
      );
      const two = findItem(
        findSection(
          buildReviewSummary(
            completeInput({ steps: sessionSteps, sessionCount: 2 })
          ),
          'sessions'
        ),
        'Time slots'
      );
      expect(one?.value).toBe('1 slot');
      expect(two?.value).toBe('2 slots');
    });

    it('marks zero counts as missing, with a participant-facing note, for questions and tasks', () => {
      const questions = findItem(
        findSection(
          buildReviewSummary(completeInput({ steps: surveySteps, questionCount: 0 })),
          'questions'
        ),
        'Questions'
      );
      const tasks = findItem(
        findSection(
          buildReviewSummary(
            completeInput({ steps: unmoderatedSteps, taskCount: 0 })
          ),
          'taskList'
        ),
        'Tasks'
      );
      expect(questions?.missing).toBe(true);
      expect(questions?.note).toMatch(/participant/i);
      expect(tasks?.missing).toBe(true);
      expect(tasks?.note).toMatch(/participant/i);
    });

    it('notes that a participant cannot book anything when there are no slots', () => {
      const item = findItem(
        findSection(
          buildReviewSummary(completeInput({ steps: sessionSteps, sessionCount: 0 })),
          'sessions'
        ),
        'Time slots'
      );
      expect(item?.missing).toBe(true);
      expect(item?.note).toMatch(/cannot book/i);
    });
  });

  describe('estimated completion time', () => {
    const surveySteps: ReviewStepRef[] = [
      { id: 1, key: 'basics', title: 'Basic Information' },
      { id: 3, key: 'questions', title: 'Questions' },
      { id: 5, key: 'review', title: 'Review' }
    ];

    it('shows the minute count when known', () => {
      const item = findItem(
        findSection(
          buildReviewSummary(
            completeInput({ steps: surveySteps, estimatedMinutes: 7 })
          ),
          'questions'
        ),
        'Estimated completion time'
      );
      expect(item?.value).toBe('7 minutes');
      expect(item?.missing).toBeFalsy();
    });

    it('is missing, with "Not estimated", when null', () => {
      const item = findItem(
        findSection(
          buildReviewSummary(
            completeInput({ steps: surveySteps, estimatedMinutes: null })
          ),
          'questions'
        ),
        'Estimated completion time'
      );
      expect(item?.value).toBe('Not estimated');
      expect(item?.missing).toBe(true);
    });
  });

  describe('copied-from and linked provenance, both twins', () => {
    const surveySteps: ReviewStepRef[] = [
      { id: 1, key: 'basics', title: 'Basic Information' },
      { id: 3, key: 'questions', title: 'Questions' },
      { id: 5, key: 'review', title: 'Review' }
    ];
    const unmoderatedSteps: ReviewStepRef[] = [
      { id: 1, key: 'basics', title: 'Basic Information' },
      { id: 3, key: 'taskList', title: 'Task List' },
      { id: 5, key: 'review', title: 'Review' }
    ];

    it('names the source study when copied, for questions and for tasks', () => {
      const questions = findItem(
        findSection(
          buildReviewSummary(
            completeInput({
              steps: surveySteps,
              copiedFromStudyId: 'study-1',
              copiedFromStudyTitle: 'NPS baseline'
            })
          ),
          'questions'
        ),
        'Copied from'
      );
      const tasks = findItem(
        findSection(
          buildReviewSummary(
            completeInput({
              steps: unmoderatedSteps,
              copiedFromStudyId: 'study-2',
              copiedFromStudyTitle: 'Checkout walkthrough'
            })
          ),
          'taskList'
        ),
        'Copied from'
      );
      expect(questions?.value).toBe('NPS baseline');
      expect(questions?.note).toMatch(/independent/i);
      expect(tasks?.value).toBe('Checkout walkthrough');
      expect(tasks?.note).toMatch(/independent/i);
    });

    it('falls back to a generic name when the source title could not be resolved, for both', () => {
      const questions = findItem(
        findSection(
          buildReviewSummary(
            completeInput({
              steps: surveySteps,
              copiedFromStudyId: 'study-1',
              copiedFromStudyTitle: ''
            })
          ),
          'questions'
        ),
        'Copied from'
      );
      const tasks = findItem(
        findSection(
          buildReviewSummary(
            completeInput({
              steps: unmoderatedSteps,
              copiedFromStudyId: 'study-2',
              copiedFromStudyTitle: ''
            })
          ),
          'taskList'
        ),
        'Copied from'
      );
      /*
       * Pinned to the exact strings, per twin, because `toBeTruthy()` here is
       * what let the recorded twin ship saying "Another set of questions"
       * about a task list. A truthiness assertion over two twins passes just
       * as happily when both of them are the SAME wrong string, which is the
       * one outcome this test exists to refuse.
       */
      expect(questions?.value).toBe('Another set of questions');
      expect(tasks?.value).toBe('Another task list');
      expect(tasks?.value).not.toMatch(/question/i);
      expect(questions?.value).not.toMatch(/task/i);
    });

    it('shows a linked item, worded per noun, when linked rather than copied', () => {
      const questions = findItem(
        findSection(
          buildReviewSummary(
            completeInput({ steps: surveySteps, linkedStudyId: 'study-3' })
          ),
          'questions'
        ),
        'Linked questions'
      );
      const tasks = findItem(
        findSection(
          buildReviewSummary(
            completeInput({ steps: unmoderatedSteps, linkedStudyId: 'study-4' })
          ),
          'taskList'
        ),
        'Linked task list'
      );
      expect(questions?.value).toBe('An existing set of questions, edited in place');
      expect(tasks?.value).toBe('An existing task list, edited in place');
    });

    it('prefers Copied from over Linked when both ids happen to be set', () => {
      const section = findSection(
        buildReviewSummary(
          completeInput({
            steps: surveySteps,
            copiedFromStudyId: 'study-1',
            copiedFromStudyTitle: 'NPS baseline',
            linkedStudyId: 'study-3'
          })
        ),
        'questions'
      );
      expect(findItem(section, 'Copied from')).toBeDefined();
      expect(findItem(section, 'Linked questions')).toBeUndefined();
    });

    it('adds neither item when the content is authored fresh', () => {
      const section = findSection(
        buildReviewSummary(completeInput({ steps: surveySteps })),
        'questions'
      );
      expect(findItem(section, 'Copied from')).toBeUndefined();
      expect(findItem(section, 'Linked questions')).toBeUndefined();
    });
  });

  describe('taskList Starting URL', () => {
    const unmoderatedSteps: ReviewStepRef[] = [
      { id: 1, key: 'basics', title: 'Basic Information' },
      { id: 3, key: 'taskList', title: 'Task List' },
      { id: 5, key: 'review', title: 'Review' }
    ];

    it('shows the hostname as the value and the full URL as the note', () => {
      const item = findItem(
        findSection(
          buildReviewSummary(
            completeInput({
              steps: unmoderatedSteps,
              targetUrl: 'https://app.example.com:8443/flows/checkout'
            })
          ),
          'taskList'
        ),
        'Starting URL'
      );
      expect(item?.value).toBe('app.example.com');
      expect(item?.note).toBe('https://app.example.com:8443/flows/checkout');
      expect(item?.missing).toBeFalsy();
    });

    it('is missing, with "Not set", when there is no target URL', () => {
      const item = findItem(
        findSection(
          buildReviewSummary(completeInput({ steps: unmoderatedSteps, targetUrl: '' })),
          'taskList'
        ),
        'Starting URL'
      );
      expect(item?.value).toBe('Not set');
      expect(item?.missing).toBe(true);
    });
  });

  describe('externalLink section', () => {
    const externalLinkSteps: ReviewStepRef[] = [
      { id: 1, key: 'basics', title: 'Basic Information' },
      { id: 3, key: 'externalLink', title: 'External Link' },
      { id: 5, key: 'review', title: 'Review' }
    ];

    it('shows the hostname as the value and the full link as the note', () => {
      const section = findSection(
        buildReviewSummary(
          completeInput({
            steps: externalLinkSteps,
            externalLink: 'https://forms.example.com/abc?x=1'
          })
        ),
        'externalLink'
      );
      const item = findItem(section, 'External Link');
      expect(item?.value).toBe('forms.example.com');
      expect(item?.note).toBe('https://forms.example.com/abc?x=1');
    });

    it('is missing, with "Not set", when there is no external link', () => {
      const section = findSection(
        buildReviewSummary(
          completeInput({ steps: externalLinkSteps, externalLink: '' })
        ),
        'externalLink'
      );
      expect(findItem(section, 'External Link')?.value).toBe('Not set');
      expect(findItem(section, 'External Link')?.missing).toBe(true);
    });

    it('always states the participant-facing consequence too', () => {
      const section = findSection(
        buildReviewSummary(completeInput({ steps: externalLinkSteps })),
        'externalLink'
      );
      const item = findItem(section, 'Where the participant goes');
      expect(item?.value).toBe('A tool outside Cortex');
    });
  });

  describe('consent section', () => {
    const surveyConsentSteps: ReviewStepRef[] = [
      { id: 1, key: 'basics', title: 'Basic Information' },
      { id: 3, key: 'questions', title: 'Questions' },
      { id: 4, key: 'consent', title: 'Consent' },
      { id: 5, key: 'review', title: 'Review' }
    ];
    const unmoderatedConsentSteps: ReviewStepRef[] = [
      { id: 1, key: 'basics', title: 'Basic Information' },
      { id: 3, key: 'taskList', title: 'Task List' },
      { id: 4, key: 'consent', title: 'Consent' },
      { id: 5, key: 'review', title: 'Review' }
    ];

    it('addresses the survey consent field on a shape with a questions step', () => {
      const section = findSection(
        buildReviewSummary(completeInput({ steps: surveyConsentSteps })),
        'consent'
      );
      expect(section?.focusFieldId).toBe('inline_survey_consent_text-heading');
    });

    it('addresses the study consent field on a shape with a taskList step', () => {
      const section = findSection(
        buildReviewSummary(completeInput({ steps: unmoderatedConsentSteps })),
        'consent'
      );
      expect(section?.focusFieldId).toBe('inline_study_consent_text-heading');
    });

    it('marks empty consent wording as missing', () => {
      const item = findItem(
        findSection(
          buildReviewSummary(
            completeInput({ steps: surveyConsentSteps, consentText: '' })
          ),
          'consent'
        ),
        'Consent wording'
      );
      expect(item?.missing).toBe(true);
    });

    it('does not truncate exactly 160 characters', () => {
      const text = 'a'.repeat(160);
      const item = findItem(
        findSection(
          buildReviewSummary(
            completeInput({ steps: surveyConsentSteps, consentText: text })
          ),
          'consent'
        ),
        'Consent wording'
      );
      expect(item?.value).toBe(text);
      expect(item?.value).not.toContain('…');
      expect(item?.value).toHaveLength(160);
    });

    it('truncates 161 characters, with an ellipsis', () => {
      const text = 'a'.repeat(161);
      const item = findItem(
        findSection(
          buildReviewSummary(
            completeInput({ steps: surveyConsentSteps, consentText: text })
          ),
          'consent'
        ),
        'Consent wording'
      );
      expect(item?.value).toBe(`${'a'.repeat(160)}…`);
      expect(item?.value).toContain('…');
    });

    it('reports custom wording for a null template and for the literal "custom" id', () => {
      const nullTemplate = findItem(
        findSection(
          buildReviewSummary(
            completeInput({ steps: surveyConsentSteps, consentTemplate: null })
          ),
          'consent'
        ),
        'Approval state'
      );
      const customId = findItem(
        findSection(
          buildReviewSummary(
            completeInput({
              steps: surveyConsentSteps,
              consentTemplate: { id: 'custom', version: null }
            })
          ),
          'consent'
        ),
        'Approval state'
      );
      expect(nullTemplate?.value).toMatch(/custom wording/i);
      expect(customId?.value).toMatch(/custom wording/i);
    });

    it('reports the approved template and its version', () => {
      const item = findItem(
        findSection(
          buildReviewSummary(
            completeInput({
              steps: surveyConsentSteps,
              consentTemplate: { id: 'default-survey', version: 3 }
            })
          ),
          'consent'
        ),
        'Approval state'
      );
      expect(item?.value).toBe('Approved template, version 3');
      expect(item?.note).toMatch(/snapshotted/i);
    });
  });
});

describe('hostnameOf', () => {
  it('reads the hostname from a plain https URL', () => {
    expect(hostnameOf('https://example.com/path')).toBe('example.com');
  });

  it('excludes both the port and the path from a URL that carries them', () => {
    expect(hostnameOf('https://example.com:8443/deep/path?x=1')).toBe('example.com');
  });

  it('returns an empty string for a mailto link', () => {
    expect(hostnameOf('mailto:someone@example.com')).toBe('');
  });

  it('returns an empty string for an empty input', () => {
    expect(hostnameOf('')).toBe('');
  });

  it('returns an empty string for a non-URL string', () => {
    expect(hostnameOf('not a url at all')).toBe('');
  });
});

describe('durations are counted like everything else on this screen', () => {
  const surveyShape: ReviewStepRef[] = [
    { id: 1, key: 'basics', title: 'Basic Information' },
    { id: 2, key: 'content', title: 'Content Details' },
    { id: 8, key: 'questions', title: 'Questions' },
    { id: 5, key: 'review', title: 'Review' }
  ];
  // Default Duration exists only where a `sessions` step does.
  const sessionShape: ReviewStepRef[] = [
    { id: 1, key: 'basics', title: 'Basic Information' },
    { id: 2, key: 'content', title: 'Content Details' },
    { id: 9, key: 'sessions', title: 'Session Management' },
    { id: 5, key: 'review', title: 'Review' }
  ];

  it.each([
    [1, '1 minute'],
    [2, '2 minutes'],
    [0, '0 minutes']
  ])('estimates %i as "%s"', (minutes, expected) => {
    /*
     * A one-question survey estimates at one minute and read "1 minutes" on
     * screen. Found by driving the form, not by a test - the counts beside it
     * already went through `pluralise` and this one did not, which is the
     * shape of every plural bug: the helper exists and one call site skipped it.
     */
    const item = findItem(
      findSection(
        buildReviewSummary(completeInput({ steps: surveyShape, estimatedMinutes: minutes })),
        'questions'
      ),
      'Estimated completion time'
    );
    expect(item?.value).toBe(expected);
  });

  it.each([
    [1, '1 minute'],
    [30, '30 minutes']
  ])('states a default duration of %i as "%s"', (minutes, expected) => {
    // The twin on the Basic Information section, which had the same bug.
    const item = findItem(
      findSection(
        buildReviewSummary(
          completeInput({ steps: sessionShape, defaultDurationMinutes: minutes })
        ),
        'basics'
      ),
      'Default Duration'
    );
    expect(item?.value).toBe(expected);
  });
});

describe('a URL that is not a web address is flagged, not rendered blank', () => {
  /*
   * Sparse ids, so a builder reading POSITION where it should read IDENTITY
   * cannot pass by coincidence: External Link is id 6 at index 2, and Task List
   * is id 7 at index 2.
   */
  const externalPollSteps: ReviewStepRef[] = [
    { id: 1, key: 'basics', title: 'Basic Information' },
    { id: 2, key: 'content', title: 'Content Details' },
    { id: 6, key: 'externalLink', title: 'External Link' },
    { id: 5, key: 'review', title: 'Review' }
  ];
  const unmoderatedSteps: ReviewStepRef[] = [
    { id: 1, key: 'basics', title: 'Basic Information' },
    { id: 2, key: 'content', title: 'Content Details' },
    { id: 7, key: 'taskList', title: 'Task List' },
    { id: 4, key: 'consent', title: 'Consent' },
    { id: 5, key: 'review', title: 'Review' }
  ];

  /*
   * `hostnameOf` returns '' for every opaque scheme - `javascript:`, `mailto:`,
   * `data:` all parse and none has a hostname. The first version of these items
   * read `value: raw ? hostnameOf(raw) : 'Not set'` with `missing: !raw`, which
   * for those inputs rendered an EMPTY value with `missing` false: no icon, no
   * error token, styled exactly like a satisfied answer, on the one screen whose
   * job is to be the author's last chance to notice.
   *
   * Both twins, deliberately. The recorded one is protected upstream by
   * `isSafeTargetUrl`, so it should not be reachable there - but a property
   * pinned on one twin and not its twin is the most-repeated failure in this
   * repo, and asserting only the reachable one is how it stays that way.
   */
  it.each([
    ['javascript:alert(1)'],
    ['mailto:someone@example.com'],
    ['data:text/html,hello']
  ])('flags %s on the external-link step and shows the raw value', (raw) => {
    const item = findItem(
      findSection(
        buildReviewSummary(completeInput({ steps: externalPollSteps, externalLink: raw })),
        'externalLink'
      ),
      'External Link'
    );

    expect(item?.missing).toBe(true);
    // The raw string, not a blank: it is the thing that explains the flag.
    expect(item?.value).toBe(raw);
    expect(item?.note).toMatch(/not a web address/i);
  });

  it.each([
    ['javascript:alert(1)'],
    ['mailto:someone@example.com']
  ])('flags %s on the task-list step too', (raw) => {
    const item = findItem(
      findSection(
        buildReviewSummary(completeInput({ steps: unmoderatedSteps, targetUrl: raw })),
        'taskList'
      ),
      'Starting URL'
    );

    expect(item?.missing).toBe(true);
    expect(item?.value).toBe(raw);
  });

  it('still reduces a real web address to its hostname, and does not flag it', () => {
    const item = findItem(
      findSection(
        buildReviewSummary(
          completeInput({
            steps: externalPollSteps,
            externalLink: 'https://forms.example.org:8443/survey/abc?x=1'
          })
        ),
        'externalLink'
      ),
      'External Link'
    );

    // Not the port, not the path - what the participant reads in the address bar.
    expect(item?.value).toBe('forms.example.org');
    expect(item?.missing).toBeUndefined();
    expect(item?.note).toBe('https://forms.example.org:8443/survey/abc?x=1');
  });

  it('reports an absent link as Not set, which is a different thing from an unusable one', () => {
    const item = findItem(
      findSection(
        buildReviewSummary(completeInput({ steps: externalPollSteps, externalLink: '' })),
        'externalLink'
      ),
      'External Link'
    );

    expect(item?.value).toBe('Not set');
    expect(item?.missing).toBe(true);
    // No explanation, because there is nothing to explain - the two cases must
    // not collapse into one message.
    expect(item?.note).toBeUndefined();
  });
});

describe('stepForPublishProblem', () => {
  // An impossible real shape (a study never has both native survey questions
  // and an unmoderated task list at once) but a fine one for a pure function,
  // and the only way to prove the lookup returns the step matching the CODE
  // rather than merely the first, or only, step in the list.
  const bothShapesSteps: ReviewStepRef[] = [
    { id: 1, key: 'basics', title: 'Basic Information' },
    { id: 3, key: 'questions', title: 'Questions' },
    { id: 7, key: 'taskList', title: 'Task List' },
    { id: 5, key: 'review', title: 'Review' }
  ];

  it('sends unmoderated_study_required to the Task List step, by id and key', () => {
    const step = stepForPublishProblem('unmoderated_study_required', bothShapesSteps);
    expect(step?.id).toBe(7);
    expect(step?.key).toBe('taskList');
  });

  it('sends unmoderated_study_removed to the same Task List step', () => {
    const step = stepForPublishProblem('unmoderated_study_removed', bothShapesSteps);
    expect(step?.id).toBe(7);
    expect(step?.key).toBe('taskList');
  });

  it('sends native_survey_study_required to the Questions step, not Task List', () => {
    const step = stepForPublishProblem('native_survey_study_required', bothShapesSteps);
    expect(step?.id).toBe(3);
    expect(step?.key).toBe('questions');
  });

  it('sends external_link_required to the External Link step when present', () => {
    const steps: ReviewStepRef[] = [
      { id: 1, key: 'basics', title: 'Basic Information' },
      { id: 3, key: 'externalLink', title: 'External Link' },
      { id: 5, key: 'review', title: 'Review' }
    ];
    const step = stepForPublishProblem('external_link_required', steps);
    expect(step?.id).toBe(3);
    expect(step?.key).toBe('externalLink');
  });

  it('returns null when the relevant step is not in the list', () => {
    const steps: ReviewStepRef[] = [
      { id: 1, key: 'basics', title: 'Basic Information' },
      { id: 5, key: 'review', title: 'Review' }
    ];
    expect(stepForPublishProblem('external_link_required', steps)).toBeNull();
    expect(stepForPublishProblem('native_survey_study_required', steps)).toBeNull();
  });
});
