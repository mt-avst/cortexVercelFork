import { z } from 'zod';

import { VALIDATION } from './constants';

/**
 * "ROLES/SKILLS WANTED" contract - the structured, DISPLAY-ONLY audience a
 * researcher advertises on an opportunity, so the right people self-select
 * ("Product Manager", "ScriptRunner admin experience").
 *
 * This DESCRIBES who a study is for; it does NOT gate. Eligibility is the
 * screener's job (shared/screener.ts) - an attribute can legitimately be both
 * advertised here and enforced as a screener question, but this field never
 * refuses anyone. It is therefore PUBLIC: unlike the screener there is no
 * owner-only part and no redaction seam, so `toPublicOpportunity` passes it
 * through untouched.
 *
 * One combined field (roles and skills together), a curated suggestion list the
 * authoring UI offers, and free-add so an author can name an audience the list
 * did not anticipate. The zod schema is the authoring gate (wired into the
 * create/update opportunity schemas in backend/src/validation/schemas.ts); the
 * field type on the Opportunity interface is a plain `string[]` in shared/types.
 *
 * "No roles" is represented by the ABSENCE of the field or an empty array - both
 * mean the study advertises no specific audience.
 */

// Authoring-validation messages. Exported so both the schema tests and the
// authoring UI assert the exact sentence rather than a paraphrase.
export const TARGET_ROLES_TOO_MANY =
  'List at most 10 roles or skills';
export const TARGET_ROLE_EMPTY =
  'A role or skill cannot be blank';
export const TARGET_ROLE_TOO_LONG =
  'Each role or skill must be 60 characters or fewer';

/**
 * One role/skill entry: trimmed, non-empty, capped. Trimmed BEFORE the length
 * checks (like the opportunity title), so "   " cannot satisfy min(1) and reach
 * storage as ''.
 */
const targetRoleEntrySchema = z
  .string()
  .trim()
  .min(1, TARGET_ROLE_EMPTY)
  .max(VALIDATION.TARGET_ROLE_MAX_CHARS, TARGET_ROLE_TOO_LONG);

/**
 * The advertised audience as authored and stored. Deduped case-insensitively,
 * keeping the first spelling an author typed, so "Jira admin" and "jira admin"
 * do not both render as chips. The count cap is checked on the RAW array before
 * the dedupe transform, so an author cannot slip past it with near-duplicates.
 */
export const targetRolesSchema = z
  .array(targetRoleEntrySchema)
  .max(VALIDATION.TARGET_ROLES_MAX_COUNT, TARGET_ROLES_TOO_MANY)
  .transform((roles) => {
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const role of roles) {
      const key = role.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      deduped.push(role);
    }
    return deduped;
  });

/**
 * The curated roles/skills the authoring UI offers as suggestions. Free-add is
 * still allowed, so this is a starting point, not an allow-list - the schema
 * accepts any string within the caps above.
 */
export const TARGET_ROLE_SUGGESTIONS: readonly string[] = [
  'Product Manager',
  'Software Engineer',
  'Designer',
  'ScriptRunner admin',
  'Jira admin',
  'Confluence admin',
  'QA Engineer',
  'Team Lead',
  'Project Manager',
  'Business Analyst',
  'Marketer',
  'Sales',
  'Customer Support',
  'Data Analyst',
];
