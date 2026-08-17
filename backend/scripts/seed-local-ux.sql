-- Local development seed: realistic content for UX work.
--
-- WHY THIS EXISTS
-- The local database ships with 2 studies, 1 user and 0 bookings, so the admin
-- dashboard renders five zeros, the type filter has nothing to filter, and no
-- judgement about a list, a sort order, a density or a full-versus-empty state
-- can be made at all. Every UX session was re-inventing this by hand.
--
-- LOCAL ONLY. Never run against Kubera or any shared database: it writes fixed
-- UUIDs, fictional people and fabricated bookings.
--
--   docker start cortex-spike-pg
--   docker exec -i cortex-spike-pg psql -U postgres -d adaptalabs_dev \
--     -v ON_ERROR_STOP=1 < backend/scripts/seed-local-ux.sql
--
-- Run `backend/src/db/seed.ts` FIRST - it creates the four demo-login users and
-- the achievements this file's points and bookings hang off.
--
-- Idempotent: fixed ids throughout, ON CONFLICT DO NOTHING / DO UPDATE.
--
-- WHAT IT GIVES YOU
--   8 further users across six business units, one a second researcher_admin
--     so ownership gating has something to gate
--   11 opportunities spanning all six types, with draft, published and closed
--     statuses, one double-width card, one participant-type-specific study,
--     long and short descriptions so the card has to survive both
--   15 session slots: past and future, some full, some empty
--   17 bookings for the demo user and others: upcoming, completed, approved,
--     and one cancelled
--   30 days of view/action clicks so the analytics charts have a curve
--   AdaptaBits history and achievements for the leaderboard
--   2 pending admin requests and 2 feedback items for the superadmin surfaces
--   a recorded study with a real Task List and three sessions - one complete
--     with a transcript, one whose transcription failed, one abandoned - so
--     the reviewer surface can be walked. Playback needs S3 and will not work
--     locally; that is one of the six known local gaps.


-- A hard stop, not a comment. "LOCAL ONLY" at the top of a file is advice; this
-- is the guard. Everything below writes fixed UUIDs and fabricated bookings,
-- and the shape of a seed script is exactly the shape of a paste into the wrong
-- terminal.
BEGIN;

-- The guard runs INSIDE the transaction, and there is exactly one transaction
-- in this file. Outside it, psql's ON_ERROR_STOP is off by default, so the
-- exception printed and every INSERT below ran anyway - proven with a probe
-- against a scratch database. `psql -1` did not save it either, because the
-- file used to carry two BEGIN/COMMIT pairs: the first COMMIT closed psql's
-- wrapper and the second block committed normally. Inside the transaction a
-- raised exception aborts everything that follows.
--
-- pg_catalog-qualified so a search_path with a shadowing current_database()
-- cannot defeat it.
DO $$
BEGIN
  IF pg_catalog.current_database() <> 'adaptalabs_dev' THEN
    RAISE EXCEPTION 'seed-local-ux.sql is for the local adaptalabs_dev database only (this is %)', pg_catalog.current_database();
  END IF;
END
$$;

-- ---------------------------------------------------------------- users
INSERT INTO users (id, email, name, business_unit, role_title, role) VALUES
  ('aa000001-0000-4000-8000-000000000001', 'ravi.desai@adaptavist.com',    'Ravi Desai',      'Research',         'UX Researcher',        'researcher_admin'),
  ('aa000001-0000-4000-8000-000000000002', 'priya.raman@adaptavist.com',   'Priya Raman',     'Engineering',      'Senior Engineer',      'employee'),
  ('aa000001-0000-4000-8000-000000000003', 'tom.okafor@adaptavist.com',    'Tom Okafor',      'Customer Success', 'Support Lead',         'employee'),
  ('aa000001-0000-4000-8000-000000000004', 'elena.sokolova@adaptavist.com','Elena Sokolova',  'Product',          'Product Designer',     'employee'),
  ('aa000001-0000-4000-8000-000000000005', 'marcus.bell@adaptavist.com',   'Marcus Bell',     'Sales',            'Solutions Engineer',   'employee'),
  ('aa000001-0000-4000-8000-000000000006', 'aisha.khan@adaptavist.com',    'Aisha Khan',      'Marketing',        'Content Strategist',   'employee'),
  ('aa000001-0000-4000-8000-000000000007', 'daniel.wright@adaptavist.com', 'Daniel Wright',   'Engineering',      'Platform Engineer',    'employee'),
  ('aa000001-0000-4000-8000-000000000008', 'sofia.marino@adaptavist.com',  'Sofia Marino',    'Customer Success', 'Onboarding Specialist','employee')
-- DO NOTHING, not DO UPDATE. The previous version rewrote the role of any
-- pre-existing account sharing an address with a seeded one, which is a
-- privilege change performed by a fixture.
ON CONFLICT (email) DO NOTHING;

-- -------------------------------------------------------- opportunities
INSERT INTO opportunities
  (id, type, title, purpose_one_liner, description_optional, product_optional,
   default_duration_minutes, status, owner_user_id, external_link_optional,
   meeting_location_optional, participant_type_required, participant_type_specific_details,
   start_date, end_date, display_width, created_at)
VALUES
  -- tests (bookable)
  ('0aa00001-0000-4000-8000-000000000001', 'test',
   'ScriptRunner for Jira: the new script editor',
   'Watch engineers write and debug a script in the redesigned editor before we ship it.',
   E'We have rebuilt the script editor with inline validation, a new console and keyboard-first navigation.\n\nYou will be asked to write a short listener script, break it deliberately, and use the console to work out why. No preparation needed and you do not need to know Groovy well.',
   'ScriptRunner', 45, 'published', '633608bc-4b0e-4d60-a498-e680ee97c252',
   NULL, 'Google Meet (link sent on booking)', 'internal', NULL,
   now() - interval '9 days', now() + interval '21 days', 'single', now() - interval '11 days'),

  ('0aa00001-0000-4000-8000-000000000002', 'test',
   'Kolekti first-run experience',
   'Test whether a brand new Kolekti workspace makes sense in the first five minutes.',
   E'We will give you a fresh workspace and no instructions, and watch what you do.\n\nHonest confusion is the point - if you get stuck, that is the finding.',
   'Kolekti', 60, 'published', 'aa000001-0000-4000-8000-000000000001',
   NULL, 'Google Meet (link sent on booking)', 'any', NULL,
   now() - interval '4 days', now() + interval '26 days', 'double', now() - interval '5 days'),

  ('0aa00001-0000-4000-8000-000000000003', 'test',
   'Bitbucket pipeline templates',
   'Find out where the new pipeline template gallery loses people on first use.',
   'Closed - we have the sessions we need. Results are being written up.',
   'Bitbucket', 45, 'closed', '633608bc-4b0e-4d60-a498-e680ee97c252',
   NULL, 'Google Meet', 'internal', NULL,
   now() - interval '40 days', now() - interval '10 days', 'single', now() - interval '42 days'),

  -- interviews (bookable)
  ('0aa00001-0000-4000-8000-000000000004', 'interview',
   'How do you actually use Confluence templates?',
   'A conversation about the templates you reach for, the ones you avoid, and why.',
   'Thirty minutes, camera optional. No product to test - we just want to hear how you work.',
   'Confluence', 30, 'published', 'aa000001-0000-4000-8000-000000000001',
   NULL, 'Google Meet (link sent on booking)', 'any', NULL,
   now() - interval '6 days', now() + interval '24 days', 'single', now() - interval '7 days'),

  ('0aa00001-0000-4000-8000-000000000005', 'interview',
   'Server to Cloud migration: what actually hurt',
   'Talk us through a migration you worked on, including the parts that went badly.',
   E'We are building migration tooling and want the real story rather than the retro summary.\n\nIf you have notes, tickets or a runbook to hand, bring them.',
   NULL, 60, 'published', '633608bc-4b0e-4d60-a498-e680ee97c252',
   NULL, 'Google Meet (link sent on booking)', 'specific', 'Anyone who has run or supported a server-to-cloud migration in the last 18 months',
   now() - interval '2 days', now() + interval '30 days', 'single', now() - interval '3 days'),

  ('0aa00001-0000-4000-8000-000000000006', 'interview',
   'Support escalation workflows',
   'Understand how an escalation moves between support, engineering and the customer.',
   'Draft - do not book yet. Slots go live once the discussion guide is signed off.',
   'Jira Service Management', 45, 'draft', '633608bc-4b0e-4d60-a498-e680ee97c252',
   NULL, 'Google Meet', 'internal', NULL,
   NULL, NULL, 'single', now() - interval '1 day'),

  -- polls
  ('0aa00001-0000-4000-8000-000000000007', 'poll',
   'Which editor do you write Groovy in?',
   'One question, one click. Helps us decide which editor integrations to build next.',
   NULL, 'ScriptRunner', 5, 'published', '633608bc-4b0e-4d60-a498-e680ee97c252',
   'https://forms.gle/example-groovy-editor-poll', NULL, 'any', NULL,
   now() - interval '14 days', now() + interval '16 days', 'single', now() - interval '15 days'),

  ('0aa00001-0000-4000-8000-000000000008', 'poll',
   'How often should we ship to the Marketplace?',
   'Weekly, fortnightly or monthly - tell us what you would actually want to consume.',
   NULL, NULL, 5, 'published', 'aa000001-0000-4000-8000-000000000001',
   'https://forms.gle/example-release-cadence-poll', NULL, 'internal', NULL,
   now() - interval '20 days', now() + interval '10 days', 'single', now() - interval '21 days'),

  -- surveys
  ('0aa00001-0000-4000-8000-000000000009', 'survey',
   'Developer experience pulse, Q3',
   'Ten minutes on tooling, build times and the things that break your flow each week.',
   E'Anonymous. Results go to the platform team and are shared back in the engineering all-hands.\n\nWe run this every quarter, so trends matter more than any single answer.',
   NULL, 10, 'published', '633608bc-4b0e-4d60-a498-e680ee97c252',
   'https://forms.gle/example-devex-pulse-q3', NULL, 'internal', NULL,
   now() - interval '12 days', now() + interval '8 days', 'single', now() - interval '13 days'),

  ('0aa00001-0000-4000-8000-00000000000a', 'survey',
   'Are our docs answering your questions?',
   'Five minutes on where you look first, what you find, and what you give up on.',
   NULL, 'Confluence', 5, 'published', 'aa000001-0000-4000-8000-000000000001',
   'https://forms.gle/example-docs-survey', NULL, 'any', NULL,
   now() - interval '25 days', now() + interval '5 days', 'single', now() - interval '26 days'),

  -- question
  ('0aa00001-0000-4000-8000-00000000000b', 'question',
   'What would you automate first with AI in Jira?',
   'One open question. Answer in a sentence or a page, whichever you have time for.',
   NULL, 'Jira', 5, 'published', '633608bc-4b0e-4d60-a498-e680ee97c252',
   'https://forms.gle/example-ai-automation-question', NULL, 'any', NULL,
   now() - interval '8 days', now() + interval '22 days', 'single', now() - interval '9 days')
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------- sessions
INSERT INTO sessions (id, opportunity_id, start_time, end_time, capacity, booked_count, location_or_meet_link_optional) VALUES
  -- ScriptRunner editor test
  ('05e00001-0000-4000-8000-000000000001', '0aa00001-0000-4000-8000-000000000001', date_trunc('hour', now()) + interval '2 days 9 hours',  date_trunc('hour', now()) + interval '2 days 9 hours 45 minutes',  1, 1, 'https://meet.google.com/abc-defg-hij'),
  ('05e00001-0000-4000-8000-000000000002', '0aa00001-0000-4000-8000-000000000001', date_trunc('hour', now()) + interval '3 days 11 hours', date_trunc('hour', now()) + interval '3 days 11 hours 45 minutes', 1, 0, 'https://meet.google.com/abc-defg-hij'),
  ('05e00001-0000-4000-8000-000000000003', '0aa00001-0000-4000-8000-000000000001', date_trunc('hour', now()) + interval '5 days 14 hours', date_trunc('hour', now()) + interval '5 days 14 hours 45 minutes', 1, 0, 'https://meet.google.com/abc-defg-hij'),
  ('05e00001-0000-4000-8000-000000000004', '0aa00001-0000-4000-8000-000000000001', date_trunc('hour', now()) - interval '5 days 5 hours',  date_trunc('hour', now()) - interval '5 days 4 hours 15 minutes',  1, 1, 'https://meet.google.com/abc-defg-hij'),

  -- Kolekti first-run (group session, partly full)
  ('05e00001-0000-4000-8000-000000000005', '0aa00001-0000-4000-8000-000000000002', date_trunc('hour', now()) + interval '1 day 10 hours',  date_trunc('hour', now()) + interval '1 day 11 hours',  4, 3, 'https://meet.google.com/kol-ekti-run'),
  ('05e00001-0000-4000-8000-000000000006', '0aa00001-0000-4000-8000-000000000002', date_trunc('hour', now()) + interval '8 days 15 hours', date_trunc('hour', now()) + interval '8 days 16 hours', 4, 4, 'https://meet.google.com/kol-ekti-run'),
  ('05e00001-0000-4000-8000-000000000007', '0aa00001-0000-4000-8000-000000000002', date_trunc('hour', now()) + interval '15 days 10 hours',date_trunc('hour', now()) + interval '15 days 11 hours',4, 0, 'https://meet.google.com/kol-ekti-run'),

  -- Bitbucket templates (closed, all in the past)
  ('05e00001-0000-4000-8000-000000000008', '0aa00001-0000-4000-8000-000000000003', date_trunc('hour', now()) - interval '30 days 4 hours', date_trunc('hour', now()) - interval '30 days 3 hours 15 minutes', 1, 1, 'https://meet.google.com/bit-buck-pipe'),
  ('05e00001-0000-4000-8000-000000000009', '0aa00001-0000-4000-8000-000000000003', date_trunc('hour', now()) - interval '28 days 6 hours', date_trunc('hour', now()) - interval '28 days 5 hours 15 minutes', 1, 1, 'https://meet.google.com/bit-buck-pipe'),

  -- Confluence templates interview
  ('05e00001-0000-4000-8000-00000000000a', '0aa00001-0000-4000-8000-000000000004', date_trunc('hour', now()) + interval '4 days 13 hours', date_trunc('hour', now()) + interval '4 days 13 hours 30 minutes', 1, 1, 'https://meet.google.com/con-flue-nce'),
  ('05e00001-0000-4000-8000-00000000000b', '0aa00001-0000-4000-8000-000000000004', date_trunc('hour', now()) + interval '6 days 9 hours',  date_trunc('hour', now()) + interval '6 days 9 hours 30 minutes',  1, 0, 'https://meet.google.com/con-flue-nce'),
  ('05e00001-0000-4000-8000-00000000000c', '0aa00001-0000-4000-8000-000000000004', date_trunc('hour', now()) - interval '12 days 3 hours', date_trunc('hour', now()) - interval '12 days 2 hours 30 minutes', 1, 1, 'https://meet.google.com/con-flue-nce'),

  -- Migration interview
  ('05e00001-0000-4000-8000-00000000000d', '0aa00001-0000-4000-8000-000000000005', date_trunc('hour', now()) + interval '7 days 16 hours', date_trunc('hour', now()) + interval '7 days 17 hours', 1, 0, 'https://meet.google.com/mig-rate-now'),
  ('05e00001-0000-4000-8000-00000000000e', '0aa00001-0000-4000-8000-000000000005', date_trunc('hour', now()) + interval '9 days 11 hours', date_trunc('hour', now()) + interval '9 days 12 hours', 1, 1, 'https://meet.google.com/mig-rate-now'),
  ('05e00001-0000-4000-8000-00000000000f', '0aa00001-0000-4000-8000-000000000005', date_trunc('hour', now()) - interval '20 days 5 hours', date_trunc('hour', now()) - interval '20 days 4 hours', 1, 1, 'https://meet.google.com/mig-rate-now')
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------- bookings
-- Demo User (a1b2...) is the participant Nick logs in as: 2 upcoming, 3 past, 1 cancelled.
INSERT INTO bookings (id, user_id, session_id, status, completion_status, completed_at, created_at, cancelled_at) VALUES
  ('b0000001-0000-4000-8000-000000000001', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', '05e00001-0000-4000-8000-000000000001', 'booked',    'pending',   NULL,                          now() - interval '3 days',  NULL),
  ('b0000001-0000-4000-8000-000000000002', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', '05e00001-0000-4000-8000-00000000000a', 'booked',    'pending',   NULL,                          now() - interval '1 day',   NULL),
  ('b0000001-0000-4000-8000-000000000003', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', '05e00001-0000-4000-8000-000000000004', 'booked',    'completed', now() - interval '5 days',     now() - interval '9 days',  NULL),
  ('b0000001-0000-4000-8000-000000000004', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', '05e00001-0000-4000-8000-00000000000c', 'booked',    'approved',  now() - interval '12 days',    now() - interval '18 days', NULL),
  ('b0000001-0000-4000-8000-000000000005', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', '05e00001-0000-4000-8000-000000000008', 'booked',    'approved',  now() - interval '30 days',    now() - interval '35 days', NULL),
  ('b0000001-0000-4000-8000-000000000006', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', '05e00001-0000-4000-8000-00000000000f', 'cancelled', 'pending',   NULL,                          now() - interval '25 days', now() - interval '22 days'),
  -- other participants, so slots fill and the leaderboard has shape
  ('b0000001-0000-4000-8000-000000000007', 'aa000001-0000-4000-8000-000000000002', '05e00001-0000-4000-8000-000000000005', 'booked', 'pending',   NULL,                       now() - interval '2 days',  NULL),
  ('b0000001-0000-4000-8000-000000000008', 'aa000001-0000-4000-8000-000000000003', '05e00001-0000-4000-8000-000000000005', 'booked', 'pending',   NULL,                       now() - interval '2 days',  NULL),
  ('b0000001-0000-4000-8000-000000000009', 'aa000001-0000-4000-8000-000000000004', '05e00001-0000-4000-8000-000000000005', 'booked', 'pending',   NULL,                       now() - interval '1 day',   NULL),
  ('b0000001-0000-4000-8000-00000000000a', 'aa000001-0000-4000-8000-000000000002', '05e00001-0000-4000-8000-000000000006', 'booked', 'pending',   NULL,                       now() - interval '4 days',  NULL),
  ('b0000001-0000-4000-8000-00000000000b', 'aa000001-0000-4000-8000-000000000005', '05e00001-0000-4000-8000-000000000006', 'booked', 'pending',   NULL,                       now() - interval '4 days',  NULL),
  ('b0000001-0000-4000-8000-00000000000c', 'aa000001-0000-4000-8000-000000000006', '05e00001-0000-4000-8000-000000000006', 'booked', 'pending',   NULL,                       now() - interval '3 days',  NULL),
  ('b0000001-0000-4000-8000-00000000000d', 'aa000001-0000-4000-8000-000000000007', '05e00001-0000-4000-8000-000000000006', 'booked', 'pending',   NULL,                       now() - interval '3 days',  NULL),
  ('b0000001-0000-4000-8000-00000000000e', 'aa000001-0000-4000-8000-000000000003', '05e00001-0000-4000-8000-000000000009', 'booked', 'approved',  now() - interval '28 days', now() - interval '33 days', NULL),
  ('b0000001-0000-4000-8000-00000000000f', 'aa000001-0000-4000-8000-000000000004', '05e00001-0000-4000-8000-00000000000e', 'booked', 'pending',   NULL,                       now() - interval '2 days',  NULL),
  ('b0000001-0000-4000-8000-000000000010', 'aa000001-0000-4000-8000-000000000002', '05e00001-0000-4000-8000-00000000000f', 'booked', 'approved',  now() - interval '20 days', now() - interval '24 days', NULL),
  ('b0000001-0000-4000-8000-000000000011', 'b2c3d4e5-f6a7-8901-bcde-f12345678901', '05e00001-0000-4000-8000-000000000002', 'booked', 'pending',   NULL,                       now() - interval '1 day',   NULL)
ON CONFLICT (id) DO NOTHING;

-- keep booked_count honest against the bookings just inserted.
-- SCOPED to the sessions this file created. Without the WHERE it recomputed
-- booked_count for every session row in whatever database was on the other end
-- of the pipe, including ones it knows nothing about.
UPDATE sessions s SET booked_count = LEAST(s.capacity, (
  SELECT count(*) FROM bookings b WHERE b.session_id = s.id AND b.status = 'booked'
))
WHERE s.id::text LIKE '05e00001-0000-4000-8000-%';

-- --------------------------------------------------------------- clicks
-- view/action clicks spread over the last 30 days so analytics charts have a curve
INSERT INTO opportunity_clicks (opportunity_id, user_id, click_type, clicked_at, ip_hash)
SELECT o.id,
       NULL,
       CASE WHEN random() < 0.35 THEN 'action' ELSE 'view' END,
       now() - (random() * interval '30 days'),
       md5(o.id::text || g::text)
FROM opportunities o
CROSS JOIN generate_series(1, 18) g
WHERE o.status = 'published'
  -- Scoped to the opportunities THIS FILE created. Without it, 18 fabricated
  -- view/action rows were written for every published study in whatever
  -- database was on the other end - including real researchers' studies,
  -- whose engagement analytics then read as fiction.
  AND o.id::text LIKE '0aa00001-0000-4000-8000-%'
  AND NOT EXISTS (SELECT 1 FROM opportunity_clicks c WHERE c.opportunity_id = o.id);

-- ------------------------------------------------------------ AdaptaBits
INSERT INTO points_transactions (id, user_id, points, reason, opportunity_id, created_at) VALUES
  ('70000001-0000-4000-8000-000000000001', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', 25, 'Completed a usability test',        '0aa00001-0000-4000-8000-000000000001', now() - interval '5 days'),
  ('70000001-0000-4000-8000-000000000002', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', 20, 'Completed an interview',            '0aa00001-0000-4000-8000-000000000004', now() - interval '12 days'),
  ('70000001-0000-4000-8000-000000000003', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', 25, 'Completed a usability test',        '0aa00001-0000-4000-8000-000000000003', now() - interval '30 days'),
  ('70000001-0000-4000-8000-000000000004', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', 10, 'Answered a poll',                   '0aa00001-0000-4000-8000-000000000007', now() - interval '13 days'),
  ('70000001-0000-4000-8000-000000000005', 'aa000001-0000-4000-8000-000000000002', 25, 'Completed a usability test',        '0aa00001-0000-4000-8000-000000000003', now() - interval '29 days'),
  ('70000001-0000-4000-8000-000000000006', 'aa000001-0000-4000-8000-000000000002', 20, 'Completed an interview',            '0aa00001-0000-4000-8000-000000000005', now() - interval '20 days'),
  ('70000001-0000-4000-8000-000000000007', 'aa000001-0000-4000-8000-000000000002', 25, 'Completed a usability test',        '0aa00001-0000-4000-8000-000000000002', now() - interval '2 days'),
  ('70000001-0000-4000-8000-000000000008', 'aa000001-0000-4000-8000-000000000002', 15, 'Completed a survey',                '0aa00001-0000-4000-8000-000000000009', now() - interval '10 days'),
  ('70000001-0000-4000-8000-000000000009', 'aa000001-0000-4000-8000-000000000003', 25, 'Completed a usability test',        '0aa00001-0000-4000-8000-000000000003', now() - interval '28 days'),
  ('70000001-0000-4000-8000-00000000000a', 'aa000001-0000-4000-8000-000000000003', 15, 'Completed a survey',                '0aa00001-0000-4000-8000-00000000000a', now() - interval '6 days'),
  ('70000001-0000-4000-8000-00000000000b', 'aa000001-0000-4000-8000-000000000004', 20, 'Completed an interview',            '0aa00001-0000-4000-8000-000000000004', now() - interval '4 days'),
  ('70000001-0000-4000-8000-00000000000c', 'aa000001-0000-4000-8000-000000000005', 10, 'Answered a poll',                   '0aa00001-0000-4000-8000-000000000008', now() - interval '9 days'),
  ('70000001-0000-4000-8000-00000000000d', 'aa000001-0000-4000-8000-000000000006', 10, 'Answered a poll',                   '0aa00001-0000-4000-8000-000000000007', now() - interval '3 days'),
  ('70000001-0000-4000-8000-00000000000e', 'b2c3d4e5-f6a7-8901-bcde-f12345678901', 25, 'Completed a recorded study',        '9f0d4f19-2708-4bf6-83c6-3a4600e8ad28', now() - interval '1 day')
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_achievements (user_id, achievement_id, earned_at)
SELECT 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', a.id, now() - interval '30 days'
FROM achievements a WHERE a.name = 'First Steps'
ON CONFLICT DO NOTHING;

INSERT INTO user_achievements (user_id, achievement_id, earned_at)
SELECT 'aa000001-0000-4000-8000-000000000002', a.id, now() - interval '29 days'
FROM achievements a WHERE a.name IN ('First Steps', 'Team Player')
ON CONFLICT DO NOTHING;

-- --------------------------------------------------------- admin requests
INSERT INTO admin_requests (user_id, requested_role, status, created_at)
SELECT 'aa000001-0000-4000-8000-000000000004', 'researcher_admin', 'pending', now() - interval '2 days'
WHERE NOT EXISTS (SELECT 1 FROM admin_requests WHERE user_id = 'aa000001-0000-4000-8000-000000000004');

INSERT INTO admin_requests (user_id, requested_role, status, created_at)
SELECT 'aa000001-0000-4000-8000-000000000007', 'researcher_admin', 'pending', now() - interval '6 hours'
WHERE NOT EXISTS (SELECT 1 FROM admin_requests WHERE user_id = 'aa000001-0000-4000-8000-000000000007');

-- --------------------------------------------------------------- feedback
INSERT INTO feedback (user_id, user_name, user_email, category, feedback, url, created_at)
SELECT 'aa000001-0000-4000-8000-000000000003', 'Tom Okafor', 'tom.okafor@adaptavist.com', 'bug', 'The session times on the opportunity page do not say which timezone they are in. I booked an hour out.', '/opportunities', now() - interval '3 days'
WHERE NOT EXISTS (SELECT 1 FROM feedback WHERE user_id = 'aa000001-0000-4000-8000-000000000003');

INSERT INTO feedback (user_id, user_name, user_email, category, feedback, url, created_at)
SELECT 'aa000001-0000-4000-8000-000000000006', 'Aisha Khan', 'aisha.khan@adaptavist.com', 'feature', 'Would love an email a day before, not just on booking. I forget.', '/my-bookings', now() - interval '8 days'
WHERE NOT EXISTS (SELECT 1 FROM feedback WHERE user_id = 'aa000001-0000-4000-8000-000000000006');





-- ------------------------------------------------------------ Task List
INSERT INTO firsthand.studies (id, title, intro_text, consent_text, brand_name, estimated_duration_minutes, locale, status, owner_user_id, created_at, updated_at)
VALUES (
  'study_seed0001-pipeline-triage',
  'Triage a failing Bitbucket pipeline',
  'You will be asked to open a repository, find a failing pipeline and work out why it failed. Talk out loud as you go - there are no wrong answers and we are testing the product, not you.',
  'We record your screen and your voice for this session. We never record your camera. The recording is used by the Adaptavist research team to improve the product and is deleted after 12 months. You can stop at any time.',
  'Adaptavist',
  20,
  'en-GB',
  'launched',
  '633608bc-4b0e-4d60-a498-e680ee97c252',
  now() - interval '10 days',
  now() - interval '6 days'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO firsthand.study_steps (id, study_id, step_order, type, prompt, target_url, helper_text, is_required, options) VALUES
  ('study_seed0001-pipeline-triage_step_1', 'study_seed0001-pipeline-triage', 1, 'instruction', 'Open the repository list and find the project called payments-api. Say out loud how you found it.', 'https://bitbucket.org/', NULL, false, NULL),
  ('study_seed0001-pipeline-triage_step_2', 'study_seed0001-pipeline-triage', 2, 'instruction', 'Find the most recent failing pipeline run and open it.', 'https://bitbucket.org/', NULL, false, NULL),
  ('study_seed0001-pipeline-triage_step_3', 'study_seed0001-pipeline-triage', 3, 'instruction', 'Work out which step failed and read out the line of the log that told you.', 'https://bitbucket.org/', NULL, false, NULL),
  ('study_seed0001-pipeline-triage_step_4', 'study_seed0001-pipeline-triage', 4, 'instruction', 'Say what you would do next if this were your own repository.', 'https://bitbucket.org/', NULL, false, NULL),
  ('study_seed0001-pipeline-triage_step_end', 'study_seed0001-pipeline-triage', 5, 'end', 'Thanks - that is the end of the study.', NULL, NULL, false, NULL)
-- (study_id, id), not (id). study_steps.id used to be a global primary key and
-- migration 0010 scoped it to its study, so an ON CONFLICT naming `id` alone
-- now matches no constraint and the whole statement errors. Found by running
-- this file, not by reading it - no application query upserts study_steps, so
-- nothing else in the repo pointed at it.
ON CONFLICT (study_id, id) DO NOTHING;

INSERT INTO opportunities
  (id, type, title, purpose_one_liner, description_optional, product_optional,
   default_duration_minutes, status, owner_user_id, participant_type_required,
   start_date, end_date, display_width, firsthand_study_id, created_at)
VALUES
  ('0aa00001-0000-4000-8000-00000000000c', 'unmoderated',
   'Triage a failing Bitbucket pipeline',
   'Twenty minutes on your own, recorded, finding out why a pipeline failed.',
   E'This one is self-guided - no meeting, no moderator. You work through four short tasks in your own time while Cortex records your screen and your voice.\n\nYou will need Chrome. Nothing is captured from your camera.',
   'Bitbucket', 20, 'published', '633608bc-4b0e-4d60-a498-e680ee97c252', 'internal',
   now() - interval '6 days', now() + interval '24 days', 'single',
   'study_seed0001-pipeline-triage', now() - interval '6 days')
ON CONFLICT (id) DO NOTHING;

-- --------------------------------------------------- completed session #1
--
-- opportunity_id is set on every seeded session deliberately. It is the key the
-- per-opportunity results gate reads, and a NULL there means "cannot be
-- attributed", which is refused to everyone but a superadmin. Seeding NULL
-- would make a local pass show a researcher zero results for their own study
-- and read as a broken gate rather than as missing seed data.
INSERT INTO firsthand.runtime_sessions (
  session_id, token, study_id, study_title, participant_id, participant_display_name,
  session_status, transcript_status, microphone_permission, screen_permission,
  recording_status, upload_status, current_step_id, started_at, completed_at,
  transcript, transcript_failure_message, steps, logical_session_id, attempt_number,
  participant_email, created_via, opportunity_id, created_at, updated_at
) VALUES (
  'fhs_seed_0001', 'tok_seed_0001', 'study_seed0001-pipeline-triage', 'Triage a failing Bitbucket pipeline',
  'aa000001-0000-4000-8000-000000000002', 'Priya Raman',
  'completed', 'complete', 'granted', 'granted', 'stopped', 'complete',
  'study_seed0001-pipeline-triage_step_end',
  now() - interval '4 days 2 hours', now() - interval '4 days 1 hour 42 minutes',
  jsonb_build_object(
    'id', 'trs_seed_0001',
    'sessionId', 'fhs_seed_0001',
    'source', 'prototype_generated',
    'createdAt', to_char(now() - interval '4 days 1 hour 40 minutes', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'body', E'Participant: Right, so I am looking for payments-api. I would normally just search rather than scroll this list.\nParticipant: Found it. That took longer than it should because the list is not sorted the way I expected.\nParticipant: Okay, the failing one is at the top, red cross, that is clear enough.\nParticipant: It is the test step. The log says "Error: connect ECONNREFUSED 127.0.0.1:5432" so the database container has not come up.\nParticipant: If this were mine I would check the service definition in the pipeline file, then re-run it.',
    'segments', jsonb_build_array(
      jsonb_build_object('id','seg_0001_1','sessionId','fhs_seed_0001','stepId','study_seed0001-pipeline-triage_step_1','speaker','participant','speakerLabel','Priya Raman','text','Right, so I am looking for payments-api. I would normally just search rather than scroll this list.','timestamp', to_char(now() - interval '4 days 1 hour 58 minutes','YYYY-MM-DD"T"HH24:MI:SS"Z"')),
      jsonb_build_object('id','seg_0001_2','sessionId','fhs_seed_0001','stepId','study_seed0001-pipeline-triage_step_1','speaker','participant','speakerLabel','Priya Raman','text','Found it. That took longer than it should because the list is not sorted the way I expected.','timestamp', to_char(now() - interval '4 days 1 hour 55 minutes','YYYY-MM-DD"T"HH24:MI:SS"Z"')),
      jsonb_build_object('id','seg_0001_3','sessionId','fhs_seed_0001','stepId','study_seed0001-pipeline-triage_step_2','speaker','participant','speakerLabel','Priya Raman','text','Okay, the failing one is at the top, red cross, that is clear enough.','timestamp', to_char(now() - interval '4 days 1 hour 51 minutes','YYYY-MM-DD"T"HH24:MI:SS"Z"')),
      jsonb_build_object('id','seg_0001_4','sessionId','fhs_seed_0001','stepId','study_seed0001-pipeline-triage_step_3','speaker','participant','speakerLabel','Priya Raman','text','It is the test step. The log says Error connect ECONNREFUSED 127.0.0.1 port 5432, so the database container has not come up.','timestamp', to_char(now() - interval '4 days 1 hour 47 minutes','YYYY-MM-DD"T"HH24:MI:SS"Z"')),
      jsonb_build_object('id','seg_0001_5','sessionId','fhs_seed_0001','stepId','study_seed0001-pipeline-triage_step_4','speaker','participant','speakerLabel','Priya Raman','text','If this were mine I would check the service definition in the pipeline file, then re-run it.','timestamp', to_char(now() - interval '4 days 1 hour 43 minutes','YYYY-MM-DD"T"HH24:MI:SS"Z"'))
    )
  ),
  NULL,
  jsonb_build_array(
    jsonb_build_object('stepId','study_seed0001-pipeline-triage_step_1','order',1,'type','instruction','prompt','Open the repository list and find the project called payments-api. Say out loud how you found it.'),
    jsonb_build_object('stepId','study_seed0001-pipeline-triage_step_2','order',2,'type','instruction','prompt','Find the most recent failing pipeline run and open it.'),
    jsonb_build_object('stepId','study_seed0001-pipeline-triage_step_3','order',3,'type','instruction','prompt','Work out which step failed and read out the line of the log that told you.'),
    jsonb_build_object('stepId','study_seed0001-pipeline-triage_step_4','order',4,'type','instruction','prompt','Say what you would do next if this were your own repository.'),
    jsonb_build_object('stepId','study_seed0001-pipeline-triage_step_end','order',5,'type','end','prompt','Thanks - that is the end of the study.')
  ),
  'fhs_seed_0001', 1, 'priya.raman@adaptavist.com', 'manual', '0aa00001-0000-4000-8000-00000000000c',
  now() - interval '4 days 2 hours', now() - interval '4 days 1 hour 40 minutes'
) ON CONFLICT (session_id) DO UPDATE SET opportunity_id = EXCLUDED.opportunity_id;

INSERT INTO firsthand.recording_assets (id, session_id, file_name, mime_type, file_size_bytes, duration_seconds, storage_provider, relative_path, object_url, uploaded_at)
VALUES ('rec_seed_0001', 'fhs_seed_0001', 'session-fhs_seed_0001.webm', 'video/webm', 48213004, 1043.5, 's3', 'firsthand/recordings/fhs_seed_0001.webm', NULL, now() - interval '4 days 1 hour 41 minutes')
ON CONFLICT (id) DO NOTHING;

-- ------------------- session #2: completed, transcript failed, no asset yet
INSERT INTO firsthand.runtime_sessions (
  session_id, token, study_id, study_title, participant_id, participant_display_name,
  session_status, transcript_status, microphone_permission, screen_permission,
  recording_status, upload_status, current_step_id, started_at, completed_at,
  transcript, transcript_failure_message, steps, logical_session_id, attempt_number,
  participant_email, created_via, opportunity_id, created_at, updated_at
) VALUES (
  'fhs_seed_0002', 'tok_seed_0002', 'study_seed0001-pipeline-triage', 'Triage a failing Bitbucket pipeline',
  'aa000001-0000-4000-8000-000000000003', 'Tom Okafor',
  'completed', 'failed', 'granted', 'granted', 'stopped', 'complete',
  'study_seed0001-pipeline-triage_step_end',
  now() - interval '2 days 5 hours', now() - interval '2 days 4 hours 39 minutes',
  NULL,
  'Transcription provider returned no audio track for this recording.',
  jsonb_build_array(
    jsonb_build_object('stepId','study_seed0001-pipeline-triage_step_1','order',1,'type','instruction','prompt','Open the repository list and find the project called payments-api. Say out loud how you found it.'),
    jsonb_build_object('stepId','study_seed0001-pipeline-triage_step_2','order',2,'type','instruction','prompt','Find the most recent failing pipeline run and open it.'),
    jsonb_build_object('stepId','study_seed0001-pipeline-triage_step_3','order',3,'type','instruction','prompt','Work out which step failed and read out the line of the log that told you.'),
    jsonb_build_object('stepId','study_seed0001-pipeline-triage_step_4','order',4,'type','instruction','prompt','Say what you would do next if this were your own repository.'),
    jsonb_build_object('stepId','study_seed0001-pipeline-triage_step_end','order',5,'type','end','prompt','Thanks - that is the end of the study.')
  ),
  'fhs_seed_0002', 1, 'tom.okafor@adaptavist.com', 'manual', '0aa00001-0000-4000-8000-00000000000c',
  now() - interval '2 days 5 hours', now() - interval '2 days 4 hours 30 minutes'
) ON CONFLICT (session_id) DO UPDATE SET opportunity_id = EXCLUDED.opportunity_id;

INSERT INTO firsthand.recording_assets (id, session_id, file_name, mime_type, file_size_bytes, duration_seconds, storage_provider, relative_path, object_url, uploaded_at)
VALUES ('rec_seed_0002', 'fhs_seed_0002', 'session-fhs_seed_0002.webm', 'video/webm', 31880122, 726.0, 's3', 'firsthand/recordings/fhs_seed_0002.webm', NULL, now() - interval '2 days 4 hours 35 minutes')
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------- session #3: abandoned part way through
INSERT INTO firsthand.runtime_sessions (
  session_id, token, study_id, study_title, participant_id, participant_display_name,
  session_status, transcript_status, microphone_permission, screen_permission,
  recording_status, upload_status, current_step_id, started_at, completed_at,
  transcript, transcript_failure_message, steps, logical_session_id, attempt_number,
  participant_email, created_via, opportunity_id, created_at, updated_at
) VALUES (
  'fhs_seed_0003', 'tok_seed_0003', 'study_seed0001-pipeline-triage', 'Triage a failing Bitbucket pipeline',
  'aa000001-0000-4000-8000-000000000005', 'Marcus Bell',
  'abandoned', 'not_requested', 'granted', 'denied', 'failed', 'not_started',
  'study_seed0001-pipeline-triage_step_2',
  now() - interval '1 day 3 hours', NULL,
  NULL, NULL,
  jsonb_build_array(
    jsonb_build_object('stepId','study_seed0001-pipeline-triage_step_1','order',1,'type','instruction','prompt','Open the repository list and find the project called payments-api. Say out loud how you found it.'),
    jsonb_build_object('stepId','study_seed0001-pipeline-triage_step_2','order',2,'type','instruction','prompt','Find the most recent failing pipeline run and open it.'),
    jsonb_build_object('stepId','study_seed0001-pipeline-triage_step_3','order',3,'type','instruction','prompt','Work out which step failed and read out the line of the log that told you.'),
    jsonb_build_object('stepId','study_seed0001-pipeline-triage_step_4','order',4,'type','instruction','prompt','Say what you would do next if this were your own repository.'),
    jsonb_build_object('stepId','study_seed0001-pipeline-triage_step_end','order',5,'type','end','prompt','Thanks - that is the end of the study.')
  ),
  'fhs_seed_0003', 1, 'marcus.bell@adaptavist.com', 'manual', '0aa00001-0000-4000-8000-00000000000c',
  now() - interval '1 day 3 hours', now() - interval '1 day 2 hours 51 minutes'
) ON CONFLICT (session_id) DO UPDATE SET opportunity_id = EXCLUDED.opportunity_id;

-- ------------------------------------------- link the sessions to the opportunity
-- The reviewer reaches a recording through opportunity_session_events, not
-- through firsthand.runtime_sessions directly: session-outputs.ts asserts
-- `SELECT 1 FROM public.opportunity_session_events WHERE opportunity_id = $1
-- AND firsthand_session_id = $2`. Without these rows the review page answers
-- "Session outputs are not available. The session may not have started yet."
-- for a session that plainly did.
INSERT INTO opportunity_session_events
  (opportunity_id, participant_user_id, firsthand_session_id, event_type, occurred_at, payload)
VALUES
  ('0aa00001-0000-4000-8000-00000000000c', 'aa000001-0000-4000-8000-000000000002', 'fhs_seed_0001', 'session_started',   now() - interval '4 days 2 hours', '{}'::jsonb),
  ('0aa00001-0000-4000-8000-00000000000c', 'aa000001-0000-4000-8000-000000000002', 'fhs_seed_0001', 'session_completed', now() - interval '4 days 1 hour 42 minutes', '{}'::jsonb),
  ('0aa00001-0000-4000-8000-00000000000c', 'aa000001-0000-4000-8000-000000000003', 'fhs_seed_0002', 'session_started',   now() - interval '2 days 5 hours', '{}'::jsonb),
  ('0aa00001-0000-4000-8000-00000000000c', 'aa000001-0000-4000-8000-000000000003', 'fhs_seed_0002', 'session_completed', now() - interval '2 days 4 hours 39 minutes', '{}'::jsonb),
  ('0aa00001-0000-4000-8000-00000000000c', 'aa000001-0000-4000-8000-000000000005', 'fhs_seed_0003', 'session_started',   now() - interval '1 day 3 hours', '{}'::jsonb)
ON CONFLICT (firsthand_session_id, event_type) DO NOTHING;

-- ---------------------------------------------- AdaptaBits profiles
-- The leaderboard reads user_profiles, NOT points_transactions - so seeding
-- the transactions alone left "No participants yet!" on a page with 14 of them.
-- Derived from the transactions above so the two agree.
INSERT INTO user_profiles (user_id, total_points, monthly_points, level, sessions_completed, surveys_completed, polls_completed, questions_completed, last_activity_date)
SELECT pt.user_id,
       SUM(pt.points)::int,
       -- COALESCE, because SUM(...) FILTER over zero matching rows is NULL and
       -- monthly_points is INTEGER NOT NULL. Every seeded transaction is at most
       -- 30 days old, so on the 1st or 2nd of a month no user has an in-month
       -- row and the insert violates the constraint - which, now that this file
       -- is a single transaction, rolls back the entire seed. COUNT(*) FILTER
       -- below is safe: it returns 0, not NULL.
       COALESCE(SUM(pt.points) FILTER (WHERE pt.created_at > date_trunc('month', now())), 0)::int,
       GREATEST(1, (SUM(pt.points) / 50)::int),
       COUNT(*) FILTER (WHERE pt.reason LIKE '%test%' OR pt.reason LIKE '%recorded%')::int,
       COUNT(*) FILTER (WHERE pt.reason LIKE '%survey%')::int,
       COUNT(*) FILTER (WHERE pt.reason LIKE '%poll%')::int,
       COUNT(*) FILTER (WHERE pt.reason LIKE '%interview%')::int,
       MAX(pt.created_at)
FROM points_transactions pt
-- Seeded users only. Otherwise a real user with points and no profile row gets
-- one minted here, with `level` from this file's own points/50 rule and the
-- counters inferred from `reason LIKE`, neither of which is the application's
-- levelling logic - and because the row now exists, nothing corrects it later.
WHERE pt.user_id::text LIKE 'aa000001-0000-4000-8000-%'
   OR pt.user_id IN (
        'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        'b2c3d4e5-f6a7-8901-bcde-f12345678901'
      )
GROUP BY pt.user_id
ON CONFLICT (user_id) DO NOTHING;

COMMIT;
