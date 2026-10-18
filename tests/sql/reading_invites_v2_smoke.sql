\set ON_ERROR_STOP on
-- This script imports the standalone database authorization + audit checks,
-- then exercises the invitation RPCs against a disposable PostgreSQL database.
\ir reading_access_v2_smoke.sql
\ir ../../supabase/migrations/20261018225000_room_invites_v2.sql
\ir ../../supabase/migrations/20261018230000_v2_issuance_quotas.sql

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',false);
SET ROLE authenticated;
SELECT public.v2_create_reading_room('Private invite room') AS invite_room \gset
SELECT set_config('test.invite_room', :'invite_room', false);
SELECT public.v2_create_room_invite(current_setting('test.invite_room')::uuid) AS invite_code \gset
SELECT set_config('test.invite_code', :'invite_code', false);

DO $$
BEGIN
  IF current_setting('test.invite_code') !~ '^[A-HJ-NP-Z2-9]{6}$' THEN
    RAISE EXCEPTION 'generated invite code is not a 6 character base32 token';
  END IF;
  BEGIN
    PERFORM 1 FROM public.reading_invitations_v2;
    RAISE EXCEPTION 'invitation hashes leaked to client';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM 1 FROM public.reading_invite_secret_v2;
    RAISE EXCEPTION 'invite secret leaked to client';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

-- A partner must explicitly request access, not obtain membership directly.
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false);
DO $$
BEGIN
  IF public.v2_request_room_join('BAD!') <> 'invalid_or_expired' THEN
    RAISE EXCEPTION 'invalid code was accepted';
  END IF;
  IF public.v2_request_room_join(current_setting('test.invite_code')) <> 'submitted' THEN
    RAISE EXCEPTION 'valid request was not submitted';
  END IF;
  IF EXISTS(SELECT 1 FROM public.reading_members_v2
            WHERE room_id=current_setting('test.invite_room')::uuid) THEN
    RAISE EXCEPTION 'partner became a member without owner approval';
  END IF;
END $$;

-- A third party cannot see or approve the pending request.
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000003',false);
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.reading_join_requests_v2) THEN
    RAISE EXCEPTION 'pending join request leaked to third party';
  END IF;
  IF public.v2_review_room_join(
    current_setting('test.invite_room')::uuid,
    '00000000-0000-4000-8000-000000000002'::uuid,true
  ) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'non-owner approved room membership';
  END IF;
  BEGIN
    PERFORM public.v2_create_room_invite(current_setting('test.invite_room')::uuid);
    RAISE EXCEPTION 'non-owner created an invite';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

-- Owner explicitly approves the single available partner slot.
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',false);
DO $$
BEGIN
  IF public.v2_review_room_join(
    current_setting('test.invite_room')::uuid,
    '00000000-0000-4000-8000-000000000002'::uuid,true
  ) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'owner approval failed';
  END IF;
  IF public.v2_review_room_join(
    current_setting('test.invite_room')::uuid,
    '00000000-0000-4000-8000-000000000002'::uuid,true
  ) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'approval replay unexpectedly succeeded';
  END IF;
END $$;

RESET ROLE;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.reading_members_v2
      WHERE room_id=current_setting('test.invite_room')::uuid) <> 2 THEN
    RAISE EXCEPTION 'exactly two users should be members';
  END IF;
  IF (SELECT count(*) FROM public.reading_invitations_v2
      WHERE room_id=current_setting('test.invite_room')::uuid
        AND status='redeemed') <> 1 THEN
    RAISE EXCEPTION 'invitation was not consumed';
  END IF;
END $$;

-- A different account cannot reuse a consumed code; failed attempts count.
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000003',false);
SET ROLE authenticated;
DO $$
DECLARE
  i integer;
  result text;
BEGIN
  IF public.v2_request_room_join(current_setting('test.invite_code'))
     <> 'invalid_or_expired' THEN
    RAISE EXCEPTION 'consumed code is reusable';
  END IF;
  FOR i IN 1..5 LOOP
    result := public.v2_request_room_join('WRONG');
  END LOOP;
  IF result <> 'rate_limited' THEN
    RAISE EXCEPTION 'user-level invalid code throttling did not activate: %',result;
  END IF;
  IF EXISTS(SELECT 1 FROM public.reading_rooms_v2
            WHERE id=current_setting('test.invite_room')::uuid) THEN
    RAISE EXCEPTION 'third party gained membership';
  END IF;
END $$;

-- Rotation invalidates the old invite even when a request was pending.
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',false);
SELECT public.v2_create_reading_room('Invite rotation room') AS rotation_room \gset
SELECT set_config('test.rotation_room', :'rotation_room', false);
SELECT public.v2_create_room_invite(current_setting('test.rotation_room')::uuid) AS old_invite \gset
SELECT set_config('test.old_invite', :'old_invite', false);
SELECT public.v2_create_room_invite(current_setting('test.rotation_room')::uuid) AS new_invite \gset
RESET ROLE;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.reading_invitations_v2
      WHERE room_id=current_setting('test.rotation_room')::uuid AND status='open') <> 1 THEN
    RAISE EXCEPTION 'invitation rotation left multiple open codes';
  END IF;
END $$;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false);
DO $$
BEGIN
  IF public.v2_request_room_join(current_setting('test.old_invite'))
     <> 'invalid_or_expired' THEN
    RAISE EXCEPTION 'revoked invite still works';
  END IF;
END $$;
RESET ROLE;

-- Issuance limits are enforced inside the database, not on client buttons.
-- Two rooms were created after the quota migration: one more is allowed.
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',false);
SET ROLE authenticated;
DO $quota$
DECLARE
  i integer;
  blocked boolean := false;
BEGIN
  FOR i IN 1..7 LOOP
    PERFORM public.v2_create_room_invite(current_setting('test.rotation_room')::uuid);
  END LOOP;
  BEGIN
    PERFORM public.v2_create_room_invite(current_setting('test.rotation_room')::uuid);
  EXCEPTION WHEN SQLSTATE 'P0010' THEN blocked := true;
  END;
  IF NOT blocked THEN
    RAISE EXCEPTION 'invitation issuance quota not enforced';
  END IF;

  PERFORM public.v2_create_reading_room('Quota room number three');
  blocked := false;
  BEGIN
    PERFORM public.v2_create_reading_room('Quota room number four');
  EXCEPTION WHEN SQLSTATE 'P0011' THEN blocked := true;
  END;
  IF NOT blocked THEN
    RAISE EXCEPTION 'room creation quota not enforced';
  END IF;
END $quota$;
RESET ROLE;
\echo 'PASS: owner-approved invitations, actor throttling and issuance quotas'
