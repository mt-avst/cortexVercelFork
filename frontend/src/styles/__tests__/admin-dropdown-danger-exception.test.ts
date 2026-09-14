import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Row 15 "Then": the admin row-menu "Delete" item rendered the same grey as
 * View/Edit/Copy in light mode. Root cause: two `!important` rules in the
 * THEMES cascade layer (`.admin-action-dropdown button`, unscoped, and its
 * `body.theme-light` sibling) had no `.text-danger` exception, and
 * `!important` beats a normal declaration regardless of layer or
 * specificity - so they painted Delete too, defeating the components-layer
 * "Danger item styling" rule outright.
 *
 * The real proof is Playwright (e2e/admin-delete-menu-item-red.test.ts),
 * which measures the actual rendered colour - that spec is not wired into
 * any CI gate yet (it needs a running frontend + backend), so this source
 * pin is the one guard that DOES run on the merge gate: it cannot see a
 * colour, but it can see the exception disappear, which is exactly the
 * shape of mutation that caused the original bug (someone editing one of
 * these three rules without carrying `.text-danger` forward).
 */

const CSS_PATH = join(__dirname, '..', '_themes.css');
const css = readFileSync(CSS_PATH, 'utf8');

describe('admin dropdown button rules except .text-danger (row 15 "Then")', () => {
  it('the unscoped "ALWAYS apply" button rule excepts .text-danger', () => {
    expect(css).toMatch(/\.admin-action-dropdown button:not\(\.text-danger\)\s*\{\s*color:\s*#E0E0E0\s*!important;/);
  });

  it('the unscoped button :hover rule excepts .text-danger', () => {
    expect(css).toMatch(/\.admin-action-dropdown button:hover:not\(\.text-danger\)\s*\{/);
  });

  it('the light-mode button rule excepts .text-danger', () => {
    expect(css).toMatch(/body\.theme-light \.admin-action-dropdown button:not\(\.text-danger\)\s*\{\s*color:\s*#374151\s*!important;/);
  });

  it('the light-mode button :hover rule excepts .text-danger', () => {
    expect(css).toMatch(/body\.theme-light \.admin-action-dropdown button:hover:not\(\.text-danger\)\s*\{/);
  });

  it('the generic light-mode .dropdown-item rule excepts .text-danger', () => {
    expect(css).toMatch(/body\.theme-light \.dropdown-item:not\(\.text-danger\)\s*\{\s*color:\s*var\(--text-body\);/);
  });
});
