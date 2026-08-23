import { describe, it, expect } from '@jest/globals';
import { CreateOpportunitySchema, UpdateOpportunitySchema } from '../schemas';

/**
 * `display_width` IS RETIRED, AND THIS FILE IS WHAT STOPS IT COMING BACK HALF-WAY.
 *
 * It was a superadmin setting for how wide an opportunity's pod rendered on the
 * user home page. For nine months it looked like a working feature and was not
 * one, in two independent places at once:
 *
 *   1. NOTHING PERSISTED IT. Neither schema declared the key, so
 *      `validateRequest`'s `req.body = schema.parse(req.body)` stripped it off
 *      every create and every save before any handler saw it. The create
 *      handler then read `(data as any).display_width` - a cast that reads like
 *      access to a field the parser had already deleted - so the value it wrote
 *      was always 'single'.
 *   2. NOTHING RENDERED IT. The double-width bento layout was removed from
 *      Home.tsx on 2026-08-17 by 844bae8, when the grid moved to
 *      closing-soonest ordering. The comment at Home.tsx records it: the bento
 *      arrangement "went with the grid".
 *
 * So the honest fix was not to make the setting persist. A setting that saves
 * into a column no surface reads is worse than one that visibly does nothing,
 * because it looks like it works. The control, the payload field, the type and
 * the dead CSS are gone; the COLUMN stays, because existing rows carry values
 * and dropping it buys nothing.
 *
 * WHAT WOULD BREAK HERE. Declaring `display_width` on either schema to "fix"
 * the save. The two routes fail that differently, and both were measured
 * against this tree by driving the real router with the real parse:
 *
 *   PATCH answers 400 and emits NO UPDATE at all. The key survives the parse,
 *   reaches the runtime allow-list on `PATCH /api/opportunities/:id`, and is
 *   refused because `UPDATABLE_OPPORTUNITY_COLUMNS` does not name it. The same
 *   probe against shipped code returns 200 and
 *   `UPDATE opportunities SET title = $1`.
 *
 *   POST drops it in silence. The create INSERT is a fixed 16-column list that
 *   no longer mentions the column, so the row takes the DDL default 'single'.
 *
 * So the half-measure does not merely fail to restore the feature: on PATCH it
 * breaks every save the authoring form makes. Restore a consumer first.
 *
 * That claim is dated. It is true only while the allow-list names what it names
 * today - if this file and that allow-list ever disagree, believe the probe,
 * not this comment.
 */
describe('display_width is not accepted by either opportunity schema', () => {
  // THE CONTROLS. Every assertion below is an absence, and an absence passes
  // just as well when the schema has stopped parsing or the import is wrong.
  // These prove the parser is live and these exports are the ones the routes use.
  it('CreateOpportunitySchema still parses the fields it does know', () => {
    const parsed = CreateOpportunitySchema.parse({
      type: 'test',
      title: 'A study',
      purpose_one_liner: 'Something worth ten characters'
    }) as Record<string, unknown>;

    expect(parsed.title).toBe('A study');
  });

  it('UpdateOpportunitySchema still parses the fields it does know', () => {
    const parsed = UpdateOpportunitySchema.parse({ title: 'A study' }) as Record<string, unknown>;

    expect(parsed.title).toBe('A study');
  });

  it('CreateOpportunitySchema drops display_width', () => {
    const parsed = CreateOpportunitySchema.parse({
      type: 'test',
      title: 'A study',
      purpose_one_liner: 'Something worth ten characters',
      display_width: 'double'
    }) as Record<string, unknown>;

    expect(parsed).not.toHaveProperty('display_width');
  });

  it('UpdateOpportunitySchema drops display_width', () => {
    const parsed = UpdateOpportunitySchema.parse({
      title: 'A study',
      display_width: 'double'
    }) as Record<string, unknown>;

    // The whole key set, not just this one absence: the point is that the
    // retired key buys no passage, not that one string is missing.
    expect(Object.keys(parsed)).toEqual(['title']);
  });
});
