import { describe, expect, it } from 'vitest';

import { normaliseTargetUrl } from '../targetUrl';
import { isSafeTargetUrl } from '../../shared/firsthand/url-safety';

describe('normaliseTargetUrl', () => {
  it('adds https:// to a scheme-less host, which is the whole point', () => {
    expect(normaliseTargetUrl('example.com/checkout')).toBe(
      'https://example.com/checkout'
    );
    expect(normaliseTargetUrl('example.com')).toBe('https://example.com');
  });

  it('trims first, so surrounding whitespace does not defeat the check', () => {
    expect(normaliseTargetUrl('  example.com/checkout  ')).toBe(
      'https://example.com/checkout'
    );
  });

  it('leaves an address that already carries a scheme alone', () => {
    expect(normaliseTargetUrl('https://example.com')).toBe('https://example.com');
    expect(normaliseTargetUrl('http://example.com')).toBe('http://example.com');
    // Scheme matching is case-insensitive: URL parsing lowercases it anyway,
    // and double-prefixing would corrupt a perfectly good address.
    expect(normaliseTargetUrl('HTTPS://example.com')).toBe('HTTPS://example.com');
  });

  it('leaves a relative path alone, since that is a legitimate target', () => {
    expect(normaliseTargetUrl('/checkout')).toBe('/checkout');
  });

  it('returns empty for empty or whitespace-only input, never a bare https://', () => {
    expect(normaliseTargetUrl('')).toBe('');
    expect(normaliseTargetUrl('   ')).toBe('');
  });
});

// The reason this helper is allowed to exist at all: it must not be able to
// turn something the security guard rejects into something it accepts.
describe('normaliseTargetUrl does not widen what isSafeTargetUrl accepts', () => {
  const dangerous = [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    '//evil.com',
    // The control-character forms MR !92 closed. The second slash is
    // load-bearing: the WHATWG parser strips TAB/CR/LF from anywhere, so these
    // collapse to "//evil.com" and resolve cross-origin. Without it,
    // "/<TAB>evil.com" collapses to the harmless same-origin path "/evil.com",
    // which the guard rightly accepts - a distinction this test got wrong
    // first time round.
    '/\\evil.com',
    '/\t/evil.com',
    '/\r/evil.com',
    '/\n/evil.com'
  ];

  it.each(dangerous)('still rejects %j after normalisation', (input) => {
    expect(isSafeTargetUrl(input)).toBe(false);
    expect(isSafeTargetUrl(normaliseTargetUrl(input))).toBe(false);
  });

  it('makes the scheme-less case pass the guard, which it did not before', () => {
    // This pair is the behaviour change, stated explicitly: rejected as typed,
    // accepted once normalised.
    expect(isSafeTargetUrl('example.com/checkout')).toBe(false);
    expect(isSafeTargetUrl(normaliseTargetUrl('example.com/checkout'))).toBe(true);
  });

  it('keeps a relative path passing the guard', () => {
    expect(isSafeTargetUrl(normaliseTargetUrl('/checkout'))).toBe(true);
  });
});
