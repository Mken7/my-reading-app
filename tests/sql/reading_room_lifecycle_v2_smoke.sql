\set ON_ERROR_STOP on
\ir reading_import_v2_smoke.sql
\ir ../../supabase/migrations/20261019011000_v2_room_lifecycle.sql

INSERT INTO auth.users(id) VALUES
 ('00000000-0000-4000-8000-000000000011'),
 ('00000000-0000-4000-8000-000000000012'),
 ('00000000-0000-4000-8000-000000000013'),
 ('00000000-0000-4000-8000-000000000014');

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000011',false);
SET ROLE authenticated;
SELECT public.v2_create_reading_room('Private two-seat room') AS lifecycle_room \gset
SELECT set_config('test.lifecycle_room',:'lifecycle_room',false);
SELECT public.v2_create_room_invite(current_setting('test.lifecycle_room')::uuid) AS first_code \gset
SELECT set_config('test.first_code',:'first_code',false);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000012',false);
SET ROLE authenticated;
DO $applicant$
DECLARE room uuid:=current_setting('test.lifecycle_room')::uuid;
BEGIN
  IF public.v2_request_room_join(current_setting('test.first_code'))<>'submitted' THEN
    RAISE EXCEPTION 'valid join code did not submit';
  END IF;
  IF public.v2_withdraw_room_join(room) IS DISTINCT FROM true OR
     public.v2_withdraw_room_join(room) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'applicant withdrawal not one-time';
  END IF;
  IF (SELECT count(*) FROM public.v2_my_join_requests()
    WHERE room_id=room AND status='cancelled')<>1 THEN
    RAISE EXCEPTION 'applicant did not receive withdrawn status';
  END IF;
  IF EXISTS(SELECT 1 FROM public.v2_room_roster(room)) THEN
    RAISE EXCEPTION 'pending/withdrawn account read private room roster';
  END IF;
  IF public.v2_revoke_room_invite(room) THEN
    RAISE EXCEPTION 'non-owner revoked code';
  END IF;
END $applicant$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000011',false);
SET ROLE authenticated;
DO $owner$
DECLARE room uuid:=current_setting('test.lifecycle_room')::uuid;
BEGIN
  IF public.v2_review_room_join(room,'00000000-0000-4000-8000-000000000012',true) THEN
    RAISE EXCEPTION 'withdrawn request was approved';
  END IF;
  IF (SELECT count(*) FROM public.v2_room_roster(room))<>1 THEN
    RAISE EXCEPTION 'owner alone should occupy one seat';
  END IF;
END $owner$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000013',false);
SET ROLE authenticated;
DO $other$
BEGIN
  IF public.v2_request_room_join(current_setting('test.first_code'))<>'submitted' THEN
    RAISE EXCEPTION 'second independent applicant failed';
  END IF;
END $other$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000011',false);
SET ROLE authenticated;
DO $revoke$
DECLARE room uuid:=current_setting('test.lifecycle_room')::uuid;
BEGIN
  IF public.v2_revoke_room_invite(room) IS DISTINCT FROM true OR
     public.v2_revoke_room_invite(room) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'revocation should require currently open invitation';
  END IF;
  IF public.v2_review_room_join(room,'00000000-0000-4000-8000-000000000013',true) THEN
    RAISE EXCEPTION 'old request survived revoked invitation';
  END IF;
END $revoke$;
SELECT public.v2_create_room_invite(current_setting('test.lifecycle_room')::uuid) AS second_code \gset
SELECT set_config('test.second_code',:'second_code',false);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000013',false);
SET ROLE authenticated;
DO $rejected$
DECLARE room uuid:=current_setting('test.lifecycle_room')::uuid;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.v2_my_join_requests()
    WHERE room_id=room AND status='rejected') THEN
    RAISE EXCEPTION 'rejected request not visible to its author';
  END IF;
  IF public.v2_request_room_join(current_setting('test.first_code'))<>'invalid_or_expired' THEN
    RAISE EXCEPTION 'revoked old code is usable';
  END IF;
END $rejected$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000012',false);
SET ROLE authenticated;
DO $again$
BEGIN
  IF public.v2_request_room_join(current_setting('test.second_code'))<>'submitted' THEN
    RAISE EXCEPTION 'withdrawn applicant could not explicitly apply again';
  END IF;
END $again$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000011',false);
SET ROLE authenticated;
DO $approve$
DECLARE room uuid:=current_setting('test.lifecycle_room')::uuid;
BEGIN
  IF public.v2_review_room_join(room,'00000000-0000-4000-8000-000000000012',true)
     IS DISTINCT FROM true OR
     public.v2_review_room_join(room,'00000000-0000-4000-8000-000000000012',true)
     IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'one-time explicit owner approval violated';
  END IF;
  IF (SELECT count(*) FROM public.v2_room_roster(room))<>2 OR
     (SELECT count(*) FROM public.v2_room_roster(room) WHERE role='partner')<>1 THEN
    RAISE EXCEPTION 'owner sees wrong two-seat roster';
  END IF;
  IF public.v2_revoke_room_invite(room) THEN
    RAISE EXCEPTION 'redeemed code could be revoked as if still open';
  END IF;
  IF EXISTS(SELECT 1 FROM public.v2_my_join_requests()) THEN
    RAISE EXCEPTION 'owner saw another applicant private request history';
  END IF;
END $approve$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000012',false);
SET ROLE authenticated;
DO $member$
DECLARE room uuid:=current_setting('test.lifecycle_room')::uuid;
BEGIN
  IF (SELECT count(*) FROM public.v2_room_roster(room))<>2 OR
     (SELECT count(*) FROM public.v2_my_join_requests()
      WHERE room_id=room AND status='approved')<>1 THEN
    RAISE EXCEPTION 'approved partner cannot read only their own state';
  END IF;
  IF public.v2_withdraw_room_join(room) THEN
    RAISE EXCEPTION 'withdrawal must not evict an approved partner';
  END IF;
END $member$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000014',false);
SET ROLE authenticated;
DO $stranger$
DECLARE room uuid:=current_setting('test.lifecycle_room')::uuid;
BEGIN
  IF EXISTS(SELECT 1 FROM public.v2_room_roster(room)) OR
     EXISTS(SELECT 1 FROM public.v2_my_join_requests()) OR
     public.v2_withdraw_room_join(room) OR
     public.v2_revoke_room_invite(room) THEN
    RAISE EXCEPTION 'outsider learned roster/history or mutated invite';
  END IF;
  IF public.v2_request_room_join(current_setting('test.second_code'))<>'invalid_or_expired' THEN
    RAISE EXCEPTION 'redeemed invitation remains reusable';
  END IF;
END $stranger$;
RESET ROLE;

UPDATE public.reading_rooms_v2 SET state='closed'
WHERE id=current_setting('test.lifecycle_room')::uuid;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000011',false);
SET ROLE authenticated;
DO $closed$
DECLARE room uuid:=current_setting('test.lifecycle_room')::uuid;
BEGIN
  IF EXISTS(SELECT 1 FROM public.v2_room_roster(room)) OR
     public.v2_revoke_room_invite(room) THEN
    RAISE EXCEPTION 'closed room leaked roster or accepted revocation';
  END IF;
END $closed$;
RESET ROLE;

SET ROLE anon;
DO $anonymous$
BEGIN
  BEGIN
    PERFORM * FROM public.v2_room_roster(current_setting('test.lifecycle_room')::uuid);
    RAISE EXCEPTION 'anonymous room roster RPC accessible';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM * FROM public.v2_my_join_requests();
    RAISE EXCEPTION 'anonymous applicant history accessible';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $anonymous$;
RESET ROLE;
\echo 'PASS: two seats, approved membership, one-use invites, revoke/withdraw, roster and privacy'
