\set ON_ERROR_STOP on
\ir reading_spoiler_realtime_v2_smoke.sql
\ir ../../supabase/migrations/20261019170000_v2_room_discovery_moderation.sql

-- Existing users: owner ...11, members/applicants ...12, ...13, ...14.
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000011',false);
SET ROLE authenticated;
SELECT public.v2_create_reading_room('Confidential book title') AS found_room \gset
SELECT set_config('test.found_room',:'found_room',false);
DO $owner_listing$
DECLARE room uuid:=current_setting('test.found_room')::uuid;
BEGIN
 IF EXISTS(SELECT 1 FROM public.v2_discover_reading_rooms('',12)) THEN
  RAISE EXCEPTION 'rooms discoverable by default';
 END IF;
 IF NOT public.v2_set_room_listing(room,'Public reading circle','Join to discuss stories',true)
 THEN RAISE EXCEPTION 'owner could not opt in'; END IF;
 IF (SELECT count(*) FROM public.v2_my_room_listings() WHERE room_id=room AND listed)<>1
 THEN RAISE EXCEPTION 'listed room not present to its owner'; END IF;
 IF public.v2_set_room_listing(room,'',repeat('x',241),true) THEN
  RAISE EXCEPTION 'invalid metadata published'; END IF;
END $owner_listing$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000014',false);
SET ROLE authenticated;
DO $discover$
DECLARE room uuid:=current_setting('test.found_room')::uuid;
BEGIN
 IF (SELECT count(*) FROM public.v2_discover_reading_rooms('',1000)
     WHERE room_id=room AND public_title='Public reading circle'
       AND public_about='Join to discuss stories')<>1 THEN
   RAISE EXCEPTION 'opt-in card invisible';
 END IF;
 IF EXISTS(SELECT 1 FROM public.v2_discover_reading_rooms('Confidential book title',20))
 THEN RAISE EXCEPTION 'private title searchable'; END IF;
 IF public.v2_request_discovered_room(room)<>'submitted'
  OR public.v2_request_discovered_room(room)<>'already_requested'
  OR public.v2_withdraw_discovery_request(room) IS DISTINCT FROM true
  OR public.v2_withdraw_discovery_request(room) IS DISTINCT FROM false
  OR public.v2_request_discovered_room(room)<>'submitted' THEN
  RAISE EXCEPTION 'rate-limited request or withdrawal failed';
 END IF;
 IF (SELECT count(*) FROM public.v2_my_discovery_requests()
  WHERE room_id=room AND status='pending')<>1 THEN
  RAISE EXCEPTION 'applicant cannot read own pending state'; END IF;
 BEGIN
  PERFORM * FROM public.reading_discovery_requests_v2;
  RAISE EXCEPTION 'direct application table read allowed';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $discover$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000012',false);
SET ROLE authenticated;
DO $stranger_view$
BEGIN
 IF EXISTS(SELECT 1 FROM public.v2_discovery_inbox()) OR
    EXISTS(SELECT 1 FROM public.v2_my_discovery_requests()) OR
    EXISTS(SELECT 1 FROM public.v2_my_discovery_blocks()) THEN
  RAISE EXCEPTION 'private directory moderation disclosed to another account';
 END IF;
END $stranger_view$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000011',false);
SET ROLE authenticated;
DO $approval$
DECLARE room uuid:=current_setting('test.found_room')::uuid;
BEGIN
 IF (SELECT count(*) FROM public.v2_discovery_inbox()
  WHERE room_id=room AND requester_id='00000000-0000-4000-8000-000000000014')<>1
 OR public.v2_review_discovery_request(room,
   '00000000-0000-4000-8000-000000000014',true) IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'owner approval failed';
 END IF;
 IF (SELECT count(*) FROM public.v2_room_roster(room))<>2 OR
  EXISTS(SELECT 1 FROM public.v2_my_room_listings()
    WHERE room_id=room AND listed) THEN
  RAISE EXCEPTION 'approved room did not become private/two-seat';
 END IF;
 IF public.v2_review_discovery_request(room,
  '00000000-0000-4000-8000-000000000014',true) THEN
  RAISE EXCEPTION 'repeat approval succeeded'; END IF;
END $approval$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000013',false);
SET ROLE authenticated;
SELECT public.v2_create_reading_room('Private hidden title B') AS blocked_room \gset
SELECT set_config('test.blocked_room',:'blocked_room',false);
DO $publish_b$
BEGIN
 IF NOT public.v2_set_room_listing(current_setting('test.blocked_room')::uuid,
  'Quiet study partners','A calm public description',true)
 THEN RAISE EXCEPTION 'second room not published'; END IF;
END $publish_b$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000012',false);
SET ROLE authenticated;
DO $report_and_block$
DECLARE room uuid:=current_setting('test.blocked_room')::uuid;
BEGIN
 IF public.v2_report_discovery_room(room,'spam','Contains repeated invitations')<>'submitted'
 THEN RAISE EXCEPTION 'report submission failed'; END IF;
 IF NOT public.v2_block_discovery_room(room) THEN RAISE EXCEPTION 'block failed'; END IF;
 IF EXISTS(SELECT 1 FROM public.v2_discover_reading_rooms('',20)
  WHERE room_id=room) OR
  public.v2_request_discovered_room(room)<>'unavailable' THEN
  RAISE EXCEPTION 'blocked owner still discoverable/joinable';
 END IF;
 IF (SELECT count(*) FROM public.v2_my_discovery_blocks()
  WHERE blocked_id='00000000-0000-4000-8000-000000000013')<>1 THEN
  RAISE EXCEPTION 'personal block list not accessible'; END IF;
 IF NOT public.v2_unblock_discovery_user('00000000-0000-4000-8000-000000000013')
  OR public.v2_request_discovered_room(room)<>'submitted' THEN
  RAISE EXCEPTION 'unblock did not restore request'; END IF;
 BEGIN
  PERFORM * FROM public.reading_discovery_reports_v2;
  RAISE EXCEPTION 'untrusted client can read confidential reports';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $report_and_block$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000013',false);
SET ROLE authenticated;
DO $block_applicant$
DECLARE room uuid:=current_setting('test.blocked_room')::uuid;
BEGIN
 IF NOT public.v2_block_discovery_applicant(room,
   '00000000-0000-4000-8000-000000000012') THEN
  RAISE EXCEPTION 'owner could not block applicant'; END IF;
 IF public.v2_review_discovery_request(room,
  '00000000-0000-4000-8000-000000000012',true) THEN
  RAISE EXCEPTION 'block bypassed in owner discovery approval'; END IF;
 IF EXISTS(SELECT 1 FROM public.v2_discovery_inbox()
  WHERE room_id=room) THEN RAISE EXCEPTION 'blocked applicant still in inbox'; END IF;
END $block_applicant$;
RESET ROLE;

-- Direct invite joins are also blocked despite valid invite code.
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000013',false);
SET ROLE authenticated;
SELECT public.v2_create_room_invite(current_setting('test.blocked_room')::uuid) AS code_b \gset
SELECT set_config('test.code_b',:'code_b',false);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000012',false);
SET ROLE authenticated;
DO $blocked_invite$
BEGIN
 BEGIN
  IF public.v2_request_room_join(current_setting('test.code_b'))='submitted' THEN
   RAISE EXCEPTION 'blocked user joined via six-character invitation';
  END IF;
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 IF EXISTS(SELECT 1 FROM public.reading_join_requests_v2 q
   WHERE q.room_id=current_setting('test.blocked_room')::uuid
   AND q.requester_id=auth.uid() AND status='pending') THEN
  RAISE EXCEPTION 'blocked invite request persisted'; END IF;
END $blocked_invite$;
RESET ROLE;

-- Rate limit persists across invalid requests and ignored repeated reports.
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000014',false);
SET ROLE authenticated;
DO $request_limits$
BEGIN
  PERFORM public.v2_request_discovered_room(NULL);
  PERFORM public.v2_request_discovered_room(NULL);
  IF public.v2_request_discovered_room(NULL) <> 'rate_limited' THEN
    RAISE EXCEPTION 'requests were not rate limited across absent room IDs';
  END IF;
END $request_limits$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000012',false);
SET ROLE authenticated;
DO $report_limits$
DECLARE i integer; outcome text; room uuid:=current_setting('test.blocked_room')::uuid;
BEGIN
 FOR i IN 1..4 LOOP
  outcome:=public.v2_report_discovery_room(room,'privacy',
    'Privacy complaint with no included book text.');
  IF outcome<>'submitted' THEN
    RAISE EXCEPTION 'reports under the daily limit rejected: %',outcome;
  END IF;
 END LOOP;
 IF public.v2_report_discovery_room(room,'privacy',
   'Sixth report exceeds the daily limit')<>'rate_limited' THEN
  RAISE EXCEPTION 'report quota bypassed';
 END IF;
END $report_limits$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000013',false);
SET ROLE authenticated;
DO $withdraw_publication$
DECLARE room uuid:=current_setting('test.blocked_room')::uuid;
BEGIN
 IF NOT public.v2_set_room_listing(room,'','',false) THEN
  RAISE EXCEPTION 'owner cannot unlist room'; END IF;
 IF EXISTS(SELECT 1 FROM public.v2_my_room_listings()
   WHERE room_id=room AND listed) THEN
  RAISE EXCEPTION 'unlisting left room discoverable';
 END IF;
END $withdraw_publication$;
RESET ROLE;

SET ROLE anon;
DO $unauth$
BEGIN
 BEGIN
  PERFORM * FROM public.v2_discover_reading_rooms('',12);
  RAISE EXCEPTION 'anonymous read directory';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 BEGIN
  PERFORM public.v2_report_discovery_room(
   current_setting('test.blocked_room')::uuid,'spam','Valid complaint text');
  RAISE EXCEPTION 'anonymous report accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $unauth$;
RESET ROLE;
\echo 'PASS: opt-in privacy, discovery, moderated membership, withdraw, report, block, invite bypass'
