/**
 * The visible names of the two main areas (#169). Each name appears in the
 * header link, the page's own <h1>, its document title and every "Back to"
 * link, and they must agree, so they live here once.
 *
 * Only the names changed: the routes stay `/admin` and `/`. Tests pin these as
 * literals rather than importing them, so a rename here fails by name.
 */
/** The researcher workspace at `/admin`. */
export const CREATE_AND_MANAGE = 'Create & Manage';

/** The participant study list at `/`. */
export const PARTICIPATE = 'Participate';
