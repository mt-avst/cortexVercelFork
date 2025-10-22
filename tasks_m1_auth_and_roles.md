# tasks_m1_auth_and_roles.md

# Milestone M1  Auth and roles

## Goal
Enable SSO login, seed researcher admin roles, and expose a safe me endpoint for the app to gate UI.

## Deliverables
- OIDC SSO working for internal users
- Role model  visitor unauthenticated, employee authenticated, researcher admin
- Role seeding method for first admins
- GET api me returning user and role
- Auth guards for admin routes  server side only stubs for now

## Tasks

T1  Project setup
- Initialise repo with front end and back end folders
- Add environment loader
- Define shared types for User and Role

T2  Database bootstrap
- Create tables  users notification_preferences settings
- Add migration scripts
- Add seed script that can mark specific emails as researcher admins

T3  OIDC SSO integration
- Add OIDC client
- Implement login route start and callback
- Verify token and create or update User on first login
- Store session cookie securely http only same site lax

T4  Role middleware
- Implement role resolver from session
- Implement requireAuth and requireAdmin middlewares
- Add server side guards for any route that will be admin later

T5  Me endpoint
- GET api me returns id name email business_unit role_title role
- Returns 200 for authenticated users
- Returns 401 for anonymous

T6  Initial UI gates
- Header shows Sign in or Account based on api me
- Admin link visible only for researcher admin

T7  Config and secrets
- Add env keys
  OIDC_ISSUER
  OIDC_CLIENT_ID
  OIDC_CLIENT_SECRET
  OIDC_REDIRECT_URL
  SESSION_SECRET
  DATABASE_URL
- Add local example env file

T8  Security basics
- CSRF protection for stateful auth endpoints
- Rate limit auth routes
- Set secure cookies in prod

## Acceptance criteria
- Unauthenticated visitor can load the app and see public pages
- Clicking Sign in completes SSO and api me returns the user
- Seeded emails appear as researcher admin on api me
- Admin routes reject non admins with 403
- Session persists across refresh and clears on logout
- No secrets committed

## Test checklist
- Happy path  login success
- Role path  admin user sees admin link, normal user does not
- 401 path  api me unauthenticated returns 401
- 403 path  admin route with non admin returns 403
- Cookie flags set correctly in prod mode
- SQL migrations run clean on empty database

## Risk notes
- OIDC callback mismatch  verify redirect url in provider config
- Clock skew  allow small leeway when validating tokens
- Session fixation  regenerate session on login

## Next milestone preview
M2 Opportunities  list, detail, admin create, publish, delete, duplicate, public browse without login
