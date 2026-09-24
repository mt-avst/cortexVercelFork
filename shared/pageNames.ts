/**
 * The visible names of the two main areas (#169). Each name appears in the
 * header link, the page's own <h1> and document title, the Back links on My
 * bookings, a study's page, a survey, Analytics, Settings, Task Lists and the
 * study form, and the owner's booking email. They must agree, so they live here once, shared by
 * the frontend and the backend.
 *
 * Only the names changed: the routes stay `/admin` and `/`. Tests pin these as
 * literals rather than importing them, so a rename here fails by name.
 */
/** The researcher workspace at `/admin`. */
export const CREATE_AND_MANAGE = 'Create & Manage';

/** The participant study list at `/`. */
export const PARTICIPATE = 'Participate';
