import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * `frontend/src/shared/**` is a COMMITTED COPY of `shared/**`, made by
 * `frontend/copy-shared-types.js`, because the bundler cannot import from
 * outside `frontend/src`. The copy - not the source - is what the frontend
 * actually imports and ships.
 *
 * Nothing runs that script automatically. Not `npm run build`, not CI. So an
 * edit to a shared source reached the backend, passed every backend test, and
 * silently never reached the frontend bundle at all. That is not hypothetical:
 * the fix removing "You can stop at any time." from the default consent text
 * landed in `shared/` and left the frontend still pre-filling the old sentence
 * into a consent field, with a full green suite either side of it.
 *
 * This test is the missing feedback. It fails the moment a source and its copy
 * disagree, and the fix it names is the whole remedy.
 */

const here = path.dirname(new URL(import.meta.url).pathname);
const frontendDir = path.resolve(here, '..', '..', '..');
const rootDir = path.resolve(frontendDir, '..');

// Mirrors the mapping in copy-shared-types.js. A source added there and not
// here simply is not covered - the two lists have to be kept together.
//
// `copy-shared-types.js` copies `shared/firsthand/` as a whole DIRECTORY, so a
// new file there is copied without anybody adding it anywhere - and is then
// uncovered here, silently, which is the worst of both. It happened on the very
// next new file: `consent-templates.ts` shipped with its frontend copy
// unchecked, and an independent mutation pass proved the consequence by
// deleting the cross-kind consent refusal from the COPY alone and watching all
// 992 frontend tests pass. The directory check below closes it by construction
// rather than by anybody remembering.
const copies: Array<{ source: string; copy: string }> = [
  { source: 'shared/types/index.ts', copy: 'src/shared/types.ts' },
  { source: 'shared/constants/index.ts', copy: 'src/shared/constants.ts' },
  { source: 'shared/config/environment.ts', copy: 'src/shared/config/environment.ts' },
  { source: 'shared/test-utils/index.ts', copy: 'src/shared/test-utils.ts' },
  { source: 'shared/firsthand/consent-templates.ts', copy: 'src/shared/firsthand/consent-templates.ts' },
  { source: 'shared/firsthand/contract.ts', copy: 'src/shared/firsthand/contract.ts' },
  { source: 'shared/firsthand/inline-study.ts', copy: 'src/shared/firsthand/inline-study.ts' },
  { source: 'shared/firsthand/publish-readiness.ts', copy: 'src/shared/firsthand/publish-readiness.ts' },
  { source: 'shared/firsthand/study-input.ts', copy: 'src/shared/firsthand/study-input.ts' },
  { source: 'shared/firsthand/survey-answers.ts', copy: 'src/shared/firsthand/survey-answers.ts' },
  { source: 'shared/firsthand/survey-authoring.ts', copy: 'src/shared/firsthand/survey-authoring.ts' },
  { source: 'shared/firsthand/url-safety.ts', copy: 'src/shared/firsthand/url-safety.ts' },
];

/** Every `.ts` the firsthand directory copy actually produces. */
const firsthandSources = fs
  .readdirSync(path.join(rootDir, 'shared', 'firsthand'))
  .filter((entry) => entry.endsWith('.ts'))
  .sort();

/** Drop the generated banner, which is the one part the copy legitimately adds. */
const withoutHeader = (contents: string): string => {
  const marker = ' */\n\n';
  if (!contents.startsWith('/**\n * AUTO-GENERATED FILE')) return contents;
  const end = contents.indexOf(marker);
  return end === -1 ? contents : contents.slice(end + marker.length);
};

describe('frontend/src/shared is a current copy of shared/', () => {
  it.each(copies)('$copy matches $source', ({ source, copy }) => {
    const sourceText = fs.readFileSync(path.resolve(rootDir, source), 'utf8');
    const copyText = fs.readFileSync(path.resolve(frontendDir, copy), 'utf8');

    expect(
      withoutHeader(copyText),
      `${copy} is stale. Run \`node copy-shared-types.js\` from frontend/ and commit the result - ` +
        `the frontend imports this copy, so until you do, your change to ${source} is not in the app.`
    ).toBe(sourceText);
  });

  /**
   * The list is enumerated by hand and the script copies a whole directory, so
   * the two can silently disagree - and did, the first time a file was added to
   * `shared/firsthand/`. Compared against the directory itself, so the omission
   * is impossible rather than merely discouraged.
   */
  it('names every file the firsthand directory copy actually produces', () => {
    const listed = copies
      .map(({ source }) => source)
      .filter((source) => source.startsWith('shared/firsthand/'))
      .map((source) => source.replace('shared/firsthand/', ''))
      .sort();

    expect(listed).toEqual(firsthandSources);
  });

  it('every generated copy carries the banner, so nobody edits one by hand', () => {
    for (const { copy } of copies) {
      const copyText = fs.readFileSync(path.resolve(frontendDir, copy), 'utf8');
      expect(copyText.startsWith('/**\n * AUTO-GENERATED FILE'), `${copy} lost its banner`).toBe(true);
    }
  });

  it('the banner carries no timestamp, so a regeneration is a no-op unless content changed', () => {
    const copyText = fs.readFileSync(
      path.resolve(frontendDir, 'src/shared/firsthand/inline-study.ts'),
      'utf8'
    );
    expect(withoutHeader(copyText)).not.toBe(copyText);
    expect(copyText.slice(0, copyText.indexOf(' */'))).not.toMatch(/Generated:/);
  });
});
