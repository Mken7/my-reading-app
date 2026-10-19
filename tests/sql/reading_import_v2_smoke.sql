\set ON_ERROR_STOP on
\ir reading_note_management_v2_smoke.sql
\ir ../../supabase/migrations/20261019010000_v2_idempotent_book_import.sql

INSERT INTO auth.users(id) VALUES('00000000-0000-4000-8000-000000000010');
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000010',false);
SET ROLE authenticated;
SELECT public.v2_create_reading_room('Safe PDF TXT EPUB import') AS import_room \gset
SELECT set_config('test.import_room',:'import_room',false);
DO $owner$
DECLARE room uuid:=current_setting('test.import_room')::uuid;
BEGIN
  IF public.v2_upload_book_chunk_retry(room,0,'甲🐈乙')<>'saved' THEN
    RAISE EXCEPTION 'initial paragraph not saved';
  END IF;
  IF public.v2_upload_book_chunk_retry(room,0,'甲🐈乙')<>'already_saved' THEN
    RAISE EXCEPTION 'same document retry should be harmless';
  END IF;
  IF public.v2_upload_book_chunk_retry(room,0,'乙🐈甲')<>'conflict' THEN
    RAISE EXCEPTION 'attempt to overwrite immutable book text allowed';
  END IF;
  IF public.v2_upload_book_chunk_retry(room,1,repeat('a',3001))<>'denied' OR
     public.v2_upload_book_chunk_retry(room,2000,'out')<>'denied' THEN
    RAISE EXCEPTION 'invalid index or oversize accepted';
  END IF;
  IF public.v2_upload_book_chunk_retry(room,1,'PDF 第 2 页')<>'saved' OR
     public.v2_publish_chapter(room,0,'PDF 第 1 页',0) IS DISTINCT FROM true OR
     public.v2_publish_chapter(room,1,'PDF 第 2 页',1) IS DISTINCT FROM true OR
     public.v2_publish_chapter(room,0,'PDF 第 1 页',0) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'book chapters or safe chapter retry failed';
  END IF;
  IF public.v2_publish_chapter(room,0,'Different Title',0) THEN
    RAISE EXCEPTION 'chapter title overwrite accepted';
  END IF;
END $owner$;
RESET ROLE;

DO $quota$
DECLARE total integer;
BEGIN
  SELECT chunks_uploaded INTO total FROM public.reading_upload_quota_v2
    WHERE user_id='00000000-0000-4000-8000-000000000010';
  IF total<>2 THEN
    RAISE EXCEPTION 'duplicate retry consumed quota or failed to charge initial saves: %',total;
  END IF;
  IF (SELECT count(*) FROM public.reading_chunks_v2
    WHERE room_id=current_setting('test.import_room')::uuid)<>2 THEN
    RAISE EXCEPTION 'wrong number of committed immutable paragraphs';
  END IF;
END $quota$;

INSERT INTO public.reading_members_v2(room_id,user_id,role)
VALUES(current_setting('test.import_room')::uuid,
       '00000000-0000-4000-8000-000000000002','partner');
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false);
SET ROLE authenticated;
DO $partner$
DECLARE room uuid:=current_setting('test.import_room')::uuid;
BEGIN
  IF public.v2_upload_book_chunk_retry(room,0,'甲🐈乙')<>'denied' OR
     public.v2_upload_book_chunk_retry(room,2,'partner book')<>'denied' THEN
    RAISE EXCEPTION 'partner was allowed to import owner content';
  END IF;
END $partner$;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000003',false);
DO $stranger$
DECLARE room uuid:=current_setting('test.import_room')::uuid;
BEGIN
  IF public.v2_upload_book_chunk_retry(room,0,'甲🐈乙')<>'denied' THEN
    RAISE EXCEPTION 'stranger detected a room chunk with matching text';
  END IF;
END $stranger$;
RESET ROLE;

UPDATE public.reading_rooms_v2 SET state='closed'
WHERE id=current_setting('test.import_room')::uuid;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000010',false);
SET ROLE authenticated;
DO $closed$
DECLARE room uuid:=current_setting('test.import_room')::uuid;
BEGIN
  IF public.v2_upload_book_chunk_retry(room,0,'甲🐈乙')<>'denied' THEN
    RAISE EXCEPTION 'closed room allowed exact text retry';
  END IF;
END $closed$;
RESET ROLE;

SET ROLE anon;
DO $anon$
BEGIN
  BEGIN
    PERFORM public.v2_upload_book_chunk_retry(
      current_setting('test.import_room')::uuid,0,'甲🐈乙');
    RAISE EXCEPTION 'anonymous upload function was accessible';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $anon$;
RESET ROLE;
\echo 'PASS: TXT/EPUB/PDF immutable book retry, quotas, private read protection and idempotent chapters'
