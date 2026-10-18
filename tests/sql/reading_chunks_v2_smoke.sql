\set ON_ERROR_STOP on
-- Combined V2 security regression suite in a disposable PostgreSQL database.
\ir reading_invites_v2_smoke.sql
\ir ../../supabase/migrations/20261018231000_v2_private_book_chunks.sql

-- Only the owner can add immutable, small chunks.
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',false);
SET ROLE authenticated;
DO $owner$
DECLARE
  i integer;
BEGIN
  IF NOT public.v2_upload_book_chunk(
    current_setting('test.invite_room')::uuid,0,'Original page 1') THEN
    RAISE EXCEPTION 'owner upload failed';
  END IF;
  IF NOT public.v2_upload_book_chunk(
    current_setting('test.invite_room')::uuid,1,'Original page 2') THEN
    RAISE EXCEPTION 'owner second upload failed';
  END IF;
  IF public.v2_upload_book_chunk(
    current_setting('test.invite_room')::uuid,0,'TAMPERED') THEN
    RAISE EXCEPTION 'overwriting an existing chunk was allowed';
  END IF;
  IF public.v2_upload_book_chunk(
    current_setting('test.invite_room')::uuid,1999,repeat('x',3001)) THEN
    RAISE EXCEPTION 'oversize chunk accepted';
  END IF;
  IF public.v2_upload_book_chunk(
    current_setting('test.invite_room')::uuid,-1,'invalid index') THEN
    RAISE EXCEPTION 'negative chunk index accepted';
  END IF;
  BEGIN
    PERFORM 1 FROM public.reading_chunks_v2;
    RAISE EXCEPTION 'raw book content table leaked to client';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM 1 FROM public.reading_read_quota_v2;
    RAISE EXCEPTION 'read counters leaked to client';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- A room owner is subject to a 300-chunk daily limit; retrying an
  -- existing immutable index must not consume quota.
  FOR i IN 2..299 LOOP
    IF NOT public.v2_upload_book_chunk(
      current_setting('test.invite_room')::uuid,i,'x') THEN
      RAISE EXCEPTION 'upload % was unexpectedly denied',i;
    END IF;
  END LOOP;
  IF public.v2_upload_book_chunk(
    current_setting('test.invite_room')::uuid,300,'extra chunk') THEN
    RAISE EXCEPTION 'daily upload limit did not block chunk 301';
  END IF;
END $owner$;

-- An approved partner can read, but cannot upload.
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false);
DO $partner$
DECLARE
  chunks integer;
  contents text;
  i integer;
BEGIN
  IF public.v2_upload_book_chunk(
    current_setting('test.invite_room')::uuid,301,'tamper') THEN
    RAISE EXCEPTION 'partner was allowed to upload book content';
  END IF;
  SELECT count(*), min(body) INTO chunks,contents
    FROM public.v2_read_book_chunks(current_setting('test.invite_room')::uuid,0,1);
  IF chunks <> 1 OR contents <> 'Original page 1' THEN
    RAISE EXCEPTION 'partner failed authorized reading';
  END IF;
  IF EXISTS(SELECT 1 FROM public.v2_read_book_chunks(
    current_setting('test.invite_room')::uuid,0,3)) THEN
    RAISE EXCEPTION 'overlarge RPC batch was accepted';
  END IF;

  -- One chunk already read; 29 two-chunk reads make 59.
  FOR i IN 1..29 LOOP
    SELECT count(*) INTO chunks FROM public.v2_read_book_chunks(
      current_setting('test.invite_room')::uuid,0,2);
    IF chunks <> 2 THEN
      RAISE EXCEPTION 'allowed read % failed',i;
    END IF;
  END LOOP;
  SELECT count(*) INTO chunks FROM public.v2_read_book_chunks(
    current_setting('test.invite_room')::uuid,0,1);
  IF chunks <> 1 THEN
    RAISE EXCEPTION '60th chunk unexpectedly denied';
  END IF;
  IF EXISTS(SELECT 1 FROM public.v2_read_book_chunks(
    current_setting('test.invite_room')::uuid,0,1)) THEN
    RAISE EXCEPTION 'hourly read limit did not block chunk 61';
  END IF;
END $partner$;

-- Unauthorized account cannot read even knowing valid room UUID.
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000003',false);
DO $outsider$
BEGIN
  IF EXISTS(SELECT 1 FROM public.v2_read_book_chunks(
    current_setting('test.invite_room')::uuid,0,1)) THEN
    RAISE EXCEPTION 'non-member was able to read protected content';
  END IF;
  IF public.v2_upload_book_chunk(
    current_setting('test.invite_room')::uuid,301,'outsider') THEN
    RAISE EXCEPTION 'non-member was able to upload';
  END IF;
END $outsider$;

RESET ROLE;
SET ROLE anon;
DO $anonymous$
BEGIN
  BEGIN
    PERFORM public.v2_read_book_chunks(
      current_setting('test.invite_room')::uuid,0,1);
    RAISE EXCEPTION 'anonymous user could call read RPC';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM 1 FROM public.reading_chunks_v2;
    RAISE EXCEPTION 'anonymous user could directly read book content';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $anonymous$;
RESET ROLE;
\echo 'PASS: private content RPC, owner upload, immutable chunks and read/write quotas'
