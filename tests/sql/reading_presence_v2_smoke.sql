\set ON_ERROR_STOP on
-- Reuse the full prior isolated migrations/permission fixtures (two real members).
\ir reading_room_lifecycle_v2_smoke.sql
\ir ../../supabase/migrations/20261019150000_v2_companion_presence.sql

-- The baseline lifecycle test ends by closing the room; reopen ONLY here,
-- in the disposable PostgreSQL integration test.
UPDATE public.reading_rooms_v2 SET state='active'
WHERE id=current_setting('test.lifecycle_room')::uuid;

-- Before any heartbeat, the owner sees the partner as joined but not active.
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000011',false);
SET ROLE authenticated;
DO $owner_before$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.v2_read_companion_presence(
    current_setting('test.lifecycle_room')::uuid);
  IF r.partner_joined IS DISTINCT FROM true OR
     r.partner_active IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'presence invented a partner heartbeat';
  END IF;
  IF public.v2_heartbeat_reading(current_setting('test.lifecycle_room')::uuid)
     IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'owner could not publish spoiler-free heartbeat';
  END IF;
  IF (SELECT count(*) FROM public.reading_presence_v2
      WHERE room_id=current_setting('test.lifecycle_room')::uuid)<>1 THEN
    RAISE EXCEPTION 'heartbeat exposed unexpected rows';
  END IF;
  BEGIN
    INSERT INTO public.reading_presence_v2(room_id,user_id)
    VALUES (current_setting('test.lifecycle_room')::uuid,
      '00000000-0000-4000-8000-000000000014');
    RAISE EXCEPTION 'client forged another member heartbeat';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $owner_before$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000012',false);
SET ROLE authenticated;
DO $partner$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.v2_read_companion_presence(
    current_setting('test.lifecycle_room')::uuid);
  IF r.partner_joined IS DISTINCT FROM true OR
     r.partner_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'partner could not see fresh owner activity';
  END IF;
  IF public.v2_heartbeat_reading(current_setting('test.lifecycle_room')::uuid)
     IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'approved partner heartbeat failed';
  END IF;
END $partner$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000014',false);
SET ROLE authenticated;
DO $outsider$
BEGIN
  IF public.v2_heartbeat_reading(current_setting('test.lifecycle_room')::uuid)
     IS DISTINCT FROM false OR EXISTS (
       SELECT 1 FROM public.v2_read_companion_presence(
         current_setting('test.lifecycle_room')::uuid)
     ) OR EXISTS (SELECT 1 FROM public.reading_presence_v2) THEN
    RAISE EXCEPTION 'outsider learned presence or forged heartbeat';
  END IF;
END $outsider$;
RESET ROLE;

-- Invalidate the partner's membership; their previous heartbeat becomes
-- invisible to the owner, and all protected RPCs deny the former member.
UPDATE public.reading_members_v2 SET left_at=pg_catalog.now()
WHERE room_id=current_setting('test.lifecycle_room')::uuid
  AND user_id='00000000-0000-4000-8000-000000000012';
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000011',false);
SET ROLE authenticated;
DO $owner_after$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.v2_read_companion_presence(
    current_setting('test.lifecycle_room')::uuid);
  IF r.partner_joined IS DISTINCT FROM false OR
     r.partner_active IS DISTINCT FROM false OR
     (SELECT count(*) FROM public.reading_presence_v2)<>1 THEN
    RAISE EXCEPTION 'removed partner presence leaked to the owner';
  END IF;
END $owner_after$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000012',false);
SET ROLE authenticated;
DO $removed$
BEGIN
  IF public.v2_heartbeat_reading(current_setting('test.lifecycle_room')::uuid)
     IS DISTINCT FROM false OR EXISTS (
      SELECT 1 FROM public.v2_read_companion_presence(
        current_setting('test.lifecycle_room')::uuid)
     ) OR EXISTS (SELECT 1 FROM public.reading_presence_v2) THEN
    RAISE EXCEPTION 'removed member still has presence access';
  END IF;
END $removed$;
RESET ROLE;

UPDATE public.reading_rooms_v2 SET state='closed'
WHERE id=current_setting('test.lifecycle_room')::uuid;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000011',false);
SET ROLE authenticated;
DO $closed$
BEGIN
  IF public.v2_heartbeat_reading(current_setting('test.lifecycle_room')::uuid)
     IS DISTINCT FROM false OR EXISTS (
      SELECT 1 FROM public.v2_read_companion_presence(
        current_setting('test.lifecycle_room')::uuid)
     ) OR EXISTS (SELECT 1 FROM public.reading_presence_v2) THEN
    RAISE EXCEPTION 'closed room continued exposing activity';
  END IF;
END $closed$;
RESET ROLE;

SET ROLE anon;
DO $anonymous$
BEGIN
  BEGIN
    PERFORM public.v2_heartbeat_reading(current_setting('test.lifecycle_room')::uuid);
    RAISE EXCEPTION 'anonymous heartbeat executed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM * FROM public.v2_read_companion_presence(
      current_setting('test.lifecycle_room')::uuid);
    RAISE EXCEPTION 'anonymous presence RPC executed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $anonymous$;
RESET ROLE;
\echo 'PASS: presence RLS, no direct writes, fresh state, removed accounts, closed rooms'
