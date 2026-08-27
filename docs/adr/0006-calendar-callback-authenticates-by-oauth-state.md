# The calendar OAuth callback authenticates by state, not by session

`GET /api/calendar/auth/callback` deliberately carries **no `requireAuth`**. Do not add one.

It is entered by a top-level navigation redirected from `accounts.google.com`, and the app
session cookie is `SameSite=Strict` in production. Browsers compute SameSite across the whole
redirect chain, so that cookie is withheld on arrival: `requireAuth` there answers 401 *after*
the researcher has already granted Google access, leaving a live grant at Google, no token row,
and nothing on screen to explain it.

So the OAuth `state` is the authenticator. `/auth/connect` binds the initiating user's id to it
server-side (`utils/oauthState.ts`), the state cookie is `SameSite=Lax` because that one *does*
ride a top-level GET redirect, and the handler takes the user from the consumed state and never
from the session. That is stronger than trusting the session would have been: an attacker who
mints a state and lures a victim fails the browser binding, and even if it passed, the payload
names the attacker, so their tokens land on their own row.

Two consequences worth stating, because both have already been got wrong once:

- **The route's verdict in `authorisation-inventory.test.ts` is `in-handler-secret`,** not
  `session`. That file's exception list is deliberately one-key-and-a-reason, so a change here
  has to be written down by hand.
- **Both ends must read the same `calendarOAuthMode()`.** They were once decided separately -
  the connect route refusing demo mode always while the callback permitted it in development -
  and the pair was incoherent while each end looked right alone. `agrees with the callback
  about when a demo flow is allowed` asserts the pair across all three `NODE_ENV` values.

Nothing in this flow has been exercised against real Google; there is no OAuth client
provisioned. What IS exercised, end to end, is the credential-free demo flow.

Related: #82 (the state control this reuses), #83 (which removed the previous, dead state
check), #89, #92, #94.
