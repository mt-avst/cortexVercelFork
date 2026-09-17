import { describe, it, expect } from 'vitest';

import {
  deriveFacetOptions,
  getStudyDelivery,
  getStudyTimeBucket,
  opportunityPassesFacets,
  PUBLISHED_LIST_CAP,
  EMPTY_FACET_SELECTION,
  facetSelectionCount,
  type StudyFacetSelection,
} from '../opportunityUtils';
import type { Opportunity } from '../../api/types';

const opp = (over: Partial<Opportunity>): Opportunity =>
  ({
    id: 'o',
    type: 'test',
    title: 't',
    purpose_one_liner: 'p',
    status: 'published',
    default_duration_minutes: 30,
    ...over,
  }) as Opportunity;

describe('getStudyDelivery', () => {
  it('is external only for a question-carrying type with external delivery', () => {
    expect(getStudyDelivery(opp({ type: 'survey', delivery_mode: 'external' }))).toBe('external');
    expect(getStudyDelivery(opp({ type: 'poll', delivery_mode: 'external' }))).toBe('external');
    expect(getStudyDelivery(opp({ type: 'question', delivery_mode: 'external' }))).toBe('external');
  });

  it('is in_app for native survey/poll/question', () => {
    expect(getStudyDelivery(opp({ type: 'survey', delivery_mode: 'native' }))).toBe('in_app');
  });

  it('is in_app for test, interview and recorded regardless of delivery_mode', () => {
    expect(getStudyDelivery(opp({ type: 'test', delivery_mode: 'external' }))).toBe('in_app');
    expect(getStudyDelivery(opp({ type: 'interview', delivery_mode: 'external' }))).toBe('in_app');
    expect(getStudyDelivery(opp({ type: 'unmoderated', delivery_mode: 'external' }))).toBe('in_app');
  });

  it('treats a missing delivery_mode as external (the column default)', () => {
    expect(getStudyDelivery(opp({ type: 'survey', delivery_mode: undefined }))).toBe('external');
  });
});

describe('getStudyTimeBucket', () => {
  it('buckets test/interview from default_duration_minutes', () => {
    expect(getStudyTimeBucket(opp({ type: 'test', default_duration_minutes: 3 }))).toBe('under_5');
    expect(getStudyTimeBucket(opp({ type: 'test', default_duration_minutes: 10 }))).toBe('5_15');
    expect(getStudyTimeBucket(opp({ type: 'interview', default_duration_minutes: 20 }))).toBe('15_30');
    expect(getStudyTimeBucket(opp({ type: 'interview', default_duration_minutes: 45 }))).toBe('30_plus');
  });

  it('boundaries are lower-inclusive', () => {
    expect(getStudyTimeBucket(opp({ type: 'test', default_duration_minutes: 5 }))).toBe('5_15');
    expect(getStudyTimeBucket(opp({ type: 'test', default_duration_minutes: 15 }))).toBe('15_30');
    expect(getStudyTimeBucket(opp({ type: 'test', default_duration_minutes: 30 }))).toBe('30_plus');
  });

  it('recorded is Not specified without an estimate, and never uses default_duration_minutes', () => {
    // default 30 would be 30_plus if it were (wrongly) read.
    expect(getStudyTimeBucket(opp({ type: 'unmoderated', default_duration_minutes: 30 }))).toBe('unspecified');
  });

  it('recorded uses the estimate when a caller supplies one (one source of truth)', () => {
    expect(
      getStudyTimeBucket({
        ...opp({ type: 'unmoderated', default_duration_minutes: 30 }),
        estimated_duration_minutes: 12,
      })
    ).toBe('5_15');
  });

  it('native survey/poll/question read as under 5', () => {
    expect(getStudyTimeBucket(opp({ type: 'survey', delivery_mode: 'native' }))).toBe('under_5');
    expect(getStudyTimeBucket(opp({ type: 'question', delivery_mode: 'native' }))).toBe('under_5');
  });

  it('external hand-off is Not specified', () => {
    expect(getStudyTimeBucket(opp({ type: 'survey', delivery_mode: 'external' }))).toBe('unspecified');
  });

  // The list API has been seen concatenating a status suffix onto the type
  // (baseTypeOf's reason for existing); both helpers must strip it before the
  // exact set membership in runsNativeSurvey, or a native survey mis-buckets.
  it('handles a status-suffixed type (surveypublished) as a native survey', () => {
    expect(getStudyTimeBucket(opp({ type: 'surveypublished' as never, delivery_mode: 'native' }))).toBe('under_5');
    expect(getStudyDelivery(opp({ type: 'surveypublished' as never, delivery_mode: 'native' }))).toBe('in_app');
  });
});

describe('opportunityPassesFacets', () => {
  const base = opp({ type: 'test', default_duration_minutes: 30, target_roles: ['Designer'] });

  it('an empty selection passes everything', () => {
    expect(opportunityPassesFacets(base, EMPTY_FACET_SELECTION)).toBe(true);
  });

  it('OR within an axis', () => {
    const sel: StudyFacetSelection = { ...EMPTY_FACET_SELECTION, types: ['test', 'survey'] };
    expect(opportunityPassesFacets(opp({ type: 'test' }), sel)).toBe(true);
    expect(opportunityPassesFacets(opp({ type: 'survey', delivery_mode: 'native' }), sel)).toBe(true);
    expect(opportunityPassesFacets(opp({ type: 'interview' }), sel)).toBe(false);
  });

  it('AND across axes', () => {
    const sel: StudyFacetSelection = {
      ...EMPTY_FACET_SELECTION,
      types: ['test'],
      roles: ['Designer'],
    };
    // right type, right role
    expect(opportunityPassesFacets(opp({ type: 'test', target_roles: ['Designer'] }), sel)).toBe(true);
    // right type, wrong role
    expect(opportunityPassesFacets(opp({ type: 'test', target_roles: ['QA Engineer'] }), sel)).toBe(false);
  });

  it('roles axis is a case-insensitive intersection', () => {
    const sel: StudyFacetSelection = { ...EMPTY_FACET_SELECTION, roles: ['designer'] };
    expect(opportunityPassesFacets(opp({ target_roles: ['Designer'] }), sel)).toBe(true);
  });

  it('filters by delivery and time bucket', () => {
    const byDelivery: StudyFacetSelection = { ...EMPTY_FACET_SELECTION, deliveries: ['external'] };
    expect(opportunityPassesFacets(opp({ type: 'survey', delivery_mode: 'external' }), byDelivery)).toBe(true);
    expect(opportunityPassesFacets(opp({ type: 'test' }), byDelivery)).toBe(false);

    const byTime: StudyFacetSelection = { ...EMPTY_FACET_SELECTION, timeBuckets: ['30_plus'] };
    expect(opportunityPassesFacets(opp({ type: 'test', default_duration_minutes: 45 }), byTime)).toBe(true);
    expect(opportunityPassesFacets(opp({ type: 'test', default_duration_minutes: 5 }), byTime)).toBe(false);
  });
});

describe('deriveFacetOptions', () => {
  it('offers only values present, with the viewer profile roles first', () => {
    const list = [
      opp({ type: 'test', default_duration_minutes: 30, target_roles: ['Designer', 'Product Manager'] }),
      opp({ type: 'survey', delivery_mode: 'external', target_roles: ['QA Engineer'] }),
    ];
    const options = deriveFacetOptions(list, ['Product Manager']);

    // Profile role surfaced first, then the rest in first-seen order.
    expect(options.roles[0]).toBe('Product Manager');
    expect(options.roles).toEqual(expect.arrayContaining(['Designer', 'QA Engineer']));
    // Types in canonical order, only those present.
    expect(options.types).toEqual(['test', 'survey']);
    expect(options.deliveries).toEqual(expect.arrayContaining(['in_app', 'external']));
    expect(options.timeBuckets).toContain('30_plus'); // the 30-min test
    expect(options.timeBuckets).toContain('unspecified'); // the external survey
  });

  it('does not surface a profile role that no study advertises', () => {
    const list = [opp({ target_roles: ['Designer'] })];
    const options = deriveFacetOptions(list, ['Marketer']);
    expect(options.roles).not.toContain('Marketer');
    expect(options.roles).toEqual(['Designer']);
  });
});

describe('the client-side cap', () => {
  it('PUBLISHED_LIST_CAP is pinned to the backend MAX_OPPORTUNITIES_RETURNED literal', () => {
    // Coupled by hand across the bundle boundary: if the backend constant moves,
    // this literal and this assertion move with it.
    expect(PUBLISHED_LIST_CAP).toBe(1000);
  });
});

describe('facetSelectionCount', () => {
  it('counts the active values across all axes', () => {
    expect(facetSelectionCount(EMPTY_FACET_SELECTION)).toBe(0);
    expect(
      facetSelectionCount({ roles: ['a'], types: ['test'], deliveries: ['in_app'], timeBuckets: [] })
    ).toBe(3);
  });
});
