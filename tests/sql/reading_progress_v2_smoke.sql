\set ON_ERROR_STOP on
-- Imports all earlier V2 smoke suites on isolated PostgreSQL 16.
\ir reading_chunks_v2_smoke.sql
\ir ../../supabase/migrations/20261018234000_v2_chapters_progress.sql

-- Create a fourth test identity and an independent active room, because the
-- previous suite deliberately closed another room and exhausted upload quota.
INSERT INTO auth.users(id) VALUES('00000000-0000-4000-8000-000000000004');
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000004',false);
SET ROLE authenticated;
SELECT public.v2_create_reading_room('Chapter test room') AS progress_room \gset
SELECT set_config('test.progress_room', :'progress_room',false);

DO $owner$
DECLARE
  result record;
BEGIN
  IF NOT public.v2_upload_book_chunk(
    current_setting('test.progress_room')::uuid,0,'第一章 你好') THEN
    RAISE EXCEPTION 'owner could not upload first chapter';
  END IF;
  IF NOT public.v2_upload_book_chunk(
    current_setting('test.progress_room')::uuid,1,'中间段落') THEN
    RAISE EXCEPTION 'owner could not upload second segment';
  END IF;
  IF NOT public.v2_upload_book_chunk(
    current_setting('test.progress_room')::uuid,2,'第二章 世界') THEN
    RAISE EXCEPTION 'owner could not upload third segment';
  END IF;

  IF NOT public.v2_publish_chapter(
    current_setting('test.progress_room')::uuid,0,'第一章 你好',0)
     OR NOT public.v2_publish_chapter(
    current_setting('test.progress_room')::uuid,1,'第二章 世界',2) THEN
    RAISE EXCEPTION 'chapter registration failed';
  END IF;
  IF NOT public.v2_publish_chapter(
    current_setting('test.progress_room')::uuid,0,'第一章 你好',0) THEN
    RAISE EXCEPTION 'exact duplicate chapter should be idempotent';
  END IF;
  IF public.v2_publish_chapter(
    current_setting('test.progress_room')::uuid,0,'TAMPERED',1) THEN
    RAISE EXCEPTION 'owner unexpectedly changed immutable chapter';
  END IF;
  IF public.v2_publish_chapter(
    current_setting('test.progress_room')::uuid,2,'missing chunk',5) THEN
    RAISE EXCEPTION 'nonexistent paragraph registered as chapter';
  END IF;
  IF (SELECT count(*) FROM public.reading_chapters_v2) <> 2 THEN
    RAISE EXCEPTION 'chapter directory missing';
  END IF;

  SELECT * INTO result FROM public.v2_save_reading_progress(
    current_setting('test.progress_room')::uuid,0,0);
  IF NOT result.saved OR result.chunk_index <> 0 OR result.revision <> 1 THEN
    RAISE EXCEPTION 'initial reading bookmark not saved';
  END IF;
  SELECT * INTO result FROM public.v2_save_reading_progress(
    current_setting('test.progress_room')::uuid,1,0);
  IF result.saved OR result.chunk_index <> 0 OR result.revision <> 1 THEN
    RAISE EXCEPTION 'stale device overwrote a newer bookmark';
  END IF;
  SELECT * INTO result FROM public.v2_save_reading_progress(
    current_setting('test.progress_room')::uuid,1,1);
  IF NOT result.saved OR result.chunk_index <> 1 OR result.revision <> 2 THEN
    RAISE EXCEPTION 'optimistic cursor update failed';
  END IF;
  SELECT * INTO result FROM public.v2_get_reading_progress(
    current_setting('test.progress_room')::uuid);
  IF result.chunk_index <> 1 OR result.revision <> 2 THEN
    RAISE EXCEPTION 'reading progress not retrievable';
  END IF;
  BEGIN
    PERFORM * FROM public.reading_progress_v2;
    RAISE EXCEPTION 'private cursor table leaked through SELECT';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $owner$;

-- Only the service can assign an approved second room member.
RESET ROLE;
INSERT INTO public.reading_members_v2(room_id,user_id,role)
VALUES(current_setting('test.progress_room')::uuid,
       '00000000-0000-4000-8000-000000000002','partner');

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false);
SET ROLE authenticated;
DO $partner$
DECLARE
  result record;
BEGIN
  IF (SELECT count(*) FROM public.reading_chapters_v2) <> 2 THEN
    RAISE EXCEPTION 'partner cannot see room directory';
  END IF;
  IF public.v2_publish_chapter(
    current_setting('test.progress_room')::uuid,2,'第三章',2) THEN
    RAISE EXCEPTION 'non-owner added a chapter';
  END IF;
  IF EXISTS (SELECT 1 FROM public.v2_get_reading_progress(
    current_setting('test.progress_room')::uuid)) THEN
    RAISE EXCEPTION 'new partner can see owner progress';
  END IF;
  SELECT * INTO result FROM public.v2_save_reading_progress(
    current_setting('test.progress_room')::uuid,2,0);
  IF NOT result.saved OR result.chunk_index <> 2 OR result.revision <> 1 THEN
    RAISE EXCEPTION 'partner could not bookmark independently';
  END IF;
END $partner$;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000003',false);
DO $outsider$
BEGIN
  IF EXISTS(SELECT 1 FROM public.reading_chapters_v2) THEN
    RAISE EXCEPTION 'stranger can discover chapter titles';
  END IF;
  IF EXISTS(SELECT 1 FROM public.v2_get_reading_progress(
    current_setting('test.progress_room')::uuid)) THEN
    RAISE EXCEPTION 'stranger read progress';
  END IF;
  IF EXISTS(SELECT 1 FROM public.v2_save_reading_progress(
    current_setting('test.progress_room')::uuid,1,0)) THEN
    RAISE EXCEPTION 'stranger saved progress';
  END IF;
END $outsider$;
RESET ROLE;

UPDATE public.reading_rooms_v2 SET state='closed'
WHERE id=current_setting('test.progress_room')::uuid;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000004',false);
SET ROLE authenticated;
DO $closed$
BEGIN
  IF EXISTS(SELECT 1 FROM public.reading_chapters_v2) OR
     EXISTS(SELECT 1 FROM public.v2_get_reading_progress(
       current_setting('test.progress_room')::uuid)) OR
     EXISTS(SELECT 1 FROM public.v2_save_reading_progress(
       current_setting('test.progress_room')::uuid,2,2)) THEN
    RAISE EXCEPTION 'closed room still exposes metadata or accepts bookmark';
  END IF;
END $closed$;
RESET ROLE;
SET ROLE anon;
DO $anonymous$
BEGIN
  BEGIN
    PERFORM * FROM public.reading_chapters_v2;
    RAISE EXCEPTION 'anonymous chapter read succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM * FROM public.v2_get_reading_progress(
      current_setting('test.progress_room')::uuid);
    RAISE EXCEPTION 'anonymous RPC succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $anonymous$;
RESET ROLE;
\echo 'PASS: private chapter index and independent optimistic reading progress'
