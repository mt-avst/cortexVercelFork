import { describe, it, expect } from '@jest/globals';
import { isDemoLoginAllowed } from '../demoLogin';

/**
 * The demo routes sign anyone in as a demo ADMIN with no credential. The only
 * places they may exist are local development and a Vercel preview that has
 * opted in - and VERCEL_ENV, which the platform sets, is what makes production
 * unreachable by any value of the opt-in.
 */
describe('isDemoLoginAllowed', () => {
  it('allows development, as it always has', () => {
    expect(isDemoLoginAllowed({ NODE_ENV: 'development' })).toBe(true);
  });

  it('allows an opted-in Vercel preview', () => {
    expect(
      isDemoLoginAllowed({ NODE_ENV: 'production', VERCEL_ENV: 'preview', ENABLE_DEMO_LOGIN: 'true' })
    ).toBe(true);
  });

  it('refuses Vercel production even when opted in', () => {
    expect(
      isDemoLoginAllowed({ NODE_ENV: 'production', VERCEL_ENV: 'production', ENABLE_DEMO_LOGIN: 'true' })
    ).toBe(false);
  });

  it('refuses the opt-in off Vercel, where VERCEL_ENV is never set', () => {
    expect(isDemoLoginAllowed({ NODE_ENV: 'production', ENABLE_DEMO_LOGIN: 'true' })).toBe(false);
  });

  it('refuses a preview that has not opted in', () => {
    expect(isDemoLoginAllowed({ NODE_ENV: 'production', VERCEL_ENV: 'preview' })).toBe(false);
  });

  it('refuses any opt-in value other than the literal "true"', () => {
    expect(
      isDemoLoginAllowed({ NODE_ENV: 'production', VERCEL_ENV: 'preview', ENABLE_DEMO_LOGIN: '1' })
    ).toBe(false);
  });

  it('refuses production and test by default', () => {
    expect(isDemoLoginAllowed({ NODE_ENV: 'production' })).toBe(false);
    expect(isDemoLoginAllowed({ NODE_ENV: 'test' })).toBe(false);
  });
});
