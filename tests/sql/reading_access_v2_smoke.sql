\set ON_ERROR_STOP on
-- Run on a disposable PostgreSQL 16 instance only.
-- Minimal Supabase auth emulation for database-policy regression testing.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid()
RETURNS uuid LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;
INSERT INTO auth.users VALUES
  ('00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000002'),
  ('00000000-0000-4000-8000-000000000003');

\ir ../../supabase/migrations/20261018223000_reading_access_v2.sql

-- Authentication is supplied by the JWT context, not a request body.
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',false);
SET ROLE authenticated;
SELECT public.v2_create_reading_room('Two-person secure room') AS created_room \gset
SELECT set_config('test.room_id', :'created_room', false);

DO $$
BEGIN
  IF (SELECT count(*) FROM public.reading_rooms_v2
      WHERE id = current_setting('test.room_id')::uuid) <> 1 THEN
    RAISE EXCEPTION 'owner cannot see room';
  END IF;
  IF (SELECT count(*) FROM public.reading_members_v2
      WHERE room_id = current_setting('test.room_id')::uuid) <> 1 THEN
    RAISE EXCEPTION 'owner membership not provisioned';
  END IF;
  BEGIN
    INSERT INTO public.reading_members_v2(room_id,user_id,role)
    VALUES(current_setting('test.room_id')::uuid,
           '00000000-0000-4000-8000-000000000002','partner');
    RAISE EXCEPTION 'authenticated user could insert membership';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

-- Simulate a trusted server adding the approved partner.
RESET ROLE;
INSERT INTO public.reading_members_v2(room_id,user_id,role)
VALUES(current_setting('test.room_id')::uuid,
       '00000000-0000-4000-8000-000000000002','partner');

-- Third-slot prevention is a database constraint, not an app-only check.
DO $$
BEGIN
  BEGIN
    INSERT INTO public.reading_members_v2(room_id,user_id,role)
    VALUES(current_setting('test.room_id')::uuid,
           '00000000-0000-4000-8000-000000000003','partner');
    RAISE EXCEPTION 'third member unexpectedly joined';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

SET ROLE authenticated;
INSERT INTO public.reading_notes_v2
  (room_id,author_id,start_offset,end_offset,body,visibility)
VALUES
  (current_setting('test.room_id')::uuid,
   '00000000-0000-4000-8000-000000000001',0,10,'my private note','private'),
  (current_setting('test.room_id')::uuid,
   '00000000-0000-4000-8000-000000000001',12,18,'our shared note','shared');

DO $$
BEGIN
  IF (SELECT count(*) FROM public.reading_notes_v2) <> 2 THEN
    RAISE EXCEPTION 'author should see own private and shared notes';
  END IF;
  BEGIN
    UPDATE public.reading_notes_v2
    SET author_id = '00000000-0000-4000-8000-000000000002'
    WHERE body='our shared note';
    RAISE EXCEPTION 'author identity was mutable';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- The second legitimate member sees exactly the shared note.
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false);
DO $$
BEGIN
  IF (SELECT count(*) FROM public.reading_notes_v2) <> 1 THEN
    RAISE EXCEPTION 'partner should only see the shared note';
  END IF;
  IF EXISTS (SELECT 1 FROM public.reading_notes_v2 WHERE visibility = 'private') THEN
    RAISE EXCEPTION 'private note leaked to partner';
  END IF;
END $$;

-- Non-member must not enumerate any room, partner or notes.
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000003',false);
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.reading_rooms_v2)
    OR EXISTS(SELECT 1 FROM public.reading_members_v2)
    OR EXISTS(SELECT 1 FROM public.reading_notes_v2) THEN
    RAISE EXCEPTION 'unauthorized room/member/note access';
  END IF;
  BEGIN
    PERFORM public.v2_create_reading_room(''); -- invalid title
    RAISE EXCEPTION 'invalid title was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END $$;

RESET ROLE;
SET ROLE anon;
DO $$
BEGIN
  BEGIN
    PERFORM 1 FROM public.reading_rooms_v2;
    RAISE EXCEPTION 'anonymous table read succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.v2_create_reading_room('anonymous room');
    RAISE EXCEPTION 'anonymous RPC call succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;
\echo 'PASS: V2 access control smoke tests'
