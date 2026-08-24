import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * ESLint for Cortex.
 *
 * WHY IT LIVES AT THE ROOT. `check-release-will-deploy` fails a main pipeline
 * that changes deployable code without cutting a release, and DEPLOY_PATHS is
 * "backend frontend shared .kubera". A lint setup placed under frontend/ would
 * therefore have to be squashed as `fix:`/`feat:`, cutting a version and
 * rolling ArgoCD for a change with no runtime effect at all. The root is
 * outside those paths, so this lands as `chore:` and deploys nothing - which
 * is exactly right for tooling.
 *
 * THE RULE POLICY. This is being switched on over a mature codebase, so a
 * clean run today would mean either 373 errors or a config that asserts
 * nothing. Neither is useful. Instead:
 *
 *   - Patterns that are legitimate in their context are turned off THERE and
 *     only there, with the reason written down.
 *   - Real backlogs are ERRORS whose existing instances are recorded in
 *     eslint-suppressions.json, per file and per rule. A new instance fails
 *     even if someone fixed one elsewhere in the same change - which an
 *     aggregate count, however it is asserted, cannot do. `npm run lint:prune`
 *     mechanically shrinks the record as things get fixed.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.next/**',
    ],
  },

  // js.configs.recommended MUST come first, and must be here at all.
  // `tseslint.configs.recommended` is three layers, and its middle layer
  // (eslint-recommended) exists to SUBTRACT core rules that TypeScript already
  // catches - it sets 23 core rules to "off" on the assumption the base
  // recommended set is switched on underneath. Spreading tseslint alone
  // therefore disables no-undef, no-unreachable, no-dupe-keys and 20 others
  // while enabling nothing in their place, and leaves no-fallthrough,
  // no-cond-assign, no-constant-condition and friends never configured at all.
  // The first version of this file made exactly that mistake: 23 rules on, 23
  // off, and the `globals` import inert because no-undef - the only rule that
  // reads it - was one of the disabled ones.
  js.configs.recommended,

  ...tseslint.configs.recommended,

  {
    rules: {
      // An underscore marks a binding that is deliberately unused - a required
      // positional parameter, a discarded destructure. Honour the convention
      // rather than making people delete a name the signature still needs.
      //
      // Catch bindings follow the SAME convention rather than being blanket
      // exempt. An earlier version of this used `caughtErrorsIgnorePattern: '^'`
      // to ignore all of them, on the reasoning that `catch (e)` with an unused
      // `e` is just a catch that does not rethrow. That hid 13 sites, several of
      // which are errors being genuinely swallowed - including one in a database
      // migration - which the house rule on error handling says never to do.
      // TypeScript has supported `catch { }` with no binding since 2.5, so
      // there is no signature to preserve here the way there is for a
      // positional parameter.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // Everything below is a real backlog, and every one is an ERROR whose
      // existing instances are recorded in eslint-suppressions.json. Severity
      // is not the mechanism holding them back - the suppressions file is - and
      // it has to be `error` because ESLint only suppresses errors, not
      // warnings. A new instance in any file fails immediately.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-function-type': 'error',

      // The exemption this needs is exactly the one the rule already offers:
      // `interface Props extends React.HTMLAttributes<HTMLDivElement> {}` is
      // the idiomatic React way to name a component's props before it adds
      // anything. Switching the whole rule off would also stop it catching `{}`
      // as a type annotation, which in TypeScript means "anything non-nullish"
      // rather than "an empty object" - a genuine trap. Zero violations with
      // the option set, so it stays an error.
      '@typescript-eslint/no-empty-object-type': [
        'error',
        { allowInterfaces: 'with-single-extends' },
      ],

      // 3 occurrences, all trivially correct to fix - but every one is under
      // backend/, so fixing them here would turn a tooling change into a
      // release. First batch of the follow-up instead.
      'prefer-const': 'warn',

      '@typescript-eslint/no-require-imports': 'error',
    },
  },

  {
    files: ['frontend/src/**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // 23 existing instances, recorded in eslint-suppressions.json, and the
      // reason this whole exercise is worth doing: the recording flow now spans
      // two documents, where a stale closure costs a recording rather than a
      // stale label. Error severity so a NEW one fails; the existing ones are
      // held back by the suppressions file because the naive fix - dropping the
      // missing `loadX` into the dependency array - is an infinite render loop.
      // Each needs its own judgement and its own test.
      'react-hooks/exhaustive-deps': 'error',
    },
  },

  {
    files: [
      'backend/src/**/*.ts',
      'backend/scripts/**/*.{js,mjs,cjs,ts}',
      'shared/**/*.ts',
      'scripts/**/*.{js,mjs,cjs,ts}',
      'e2e/**/*.{ts,js}',
    ],
    languageOptions: { globals: { ...globals.node } },
  },

  {
    // Tests re-`require()` a module after mocking it, which is the documented
    // way to get a fresh instance under Jest. Forbidding it here would be
    // forbidding the technique, not catching a style slip.
    files: [
      '**/__tests__/**/*.{ts,tsx,js,jsx,mjs,cjs}',
      '**/*.test.{ts,tsx,js,jsx,mjs,cjs}',
      '**/*.spec.{ts,tsx,js,jsx,mjs,cjs}',
    ],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  {
    // The root package.json declares no "type", so a .js file under scripts/ IS
    // a CommonJS module and `require` is the only module system it has. The
    // rule is aimed at TypeScript and ESM code reaching for require anyway;
    // here it flags the language rather than a style slip, and the alternative
    // - renaming these to .mjs - would break the invocations written down in
    // the operator runbooks under archive/summaries-and-fixes/.
    //
    // Deliberately .js ONLY. scripts/*.ts and scripts/*.mjs both have real
    // module syntax available, so the rule still applies to them.
    files: ['scripts/**/*.js'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  {
    // Express request augmentation has no module-syntax equivalent: adding a
    // property to Express.Request means declaring into its namespace.
    //
    // Scoped to types/ ONLY. The one other namespace in the codebase, in
    // middleware/firsthand-session.ts, already carries its own
    // eslint-disable-next-line - and widening this override to cover it made
    // ESLint report that directive as unused, which is the tool correctly
    // objecting to two mechanisms for one exemption. Leave the source's own
    // annotation to do its job.
    files: ['backend/src/types/**/*.ts'],
    rules: {
      '@typescript-eslint/no-namespace': 'off',
    },
  }
);
