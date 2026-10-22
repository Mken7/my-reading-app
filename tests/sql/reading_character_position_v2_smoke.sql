\set ON_ERROR_STOP on
\ir reading_bookmarks_sync_v2_smoke.sql
\ir ../../supabase/migrations/20261019007000_v2_character_reading_position.sql
INSERT INTO auth.users(id) VALUES('00000000-0000-4000-8000-00000000000c');
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000000c',false);
SET ROLE authenticated;
SELECT public.v2_create_reading_room('Unicode cursor CAS test') AS position_room \gset
SELECT set_config('test.position_room',:'position_room',false);
DO $owner$
DECLARE room uuid:=current_setting('test.position_room')::uuid;
  result record;
BEGIN
  IF NOT public.v2_upload_book_chunk(room,0,'你好😀世界') OR
     NOT public.v2_upload_book_chunk(room,1,'第二段落') THEN
     RAISE EXCEPTION 'could not upload test text';
  END IF;
  -- PostgreSQL character length: 😀 occupies one code point, not two UTF-16 units.
  IF EXISTS(SELECT 1 FROM public.v2_save_reading_position(room,0,6,0)) THEN
    RAISE EXCEPTION 'oversized offset wrongly returned a result';
  END IF;
END $owner$;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000000c',false);
SET ROLE authenticated;
DO $owner2$
DECLARE room uuid:=current_setting('test.position_room')::uuid;
  result record;
BEGIN
  SELECT * INTO result FROM public.v2_save_reading_position(room,0,1,7);
  IF result.saved OR result.revision<>0 THEN
    RAISE EXCEPTION 'nonzero initial revision saved an absent Unicode position';
  END IF;
  SELECT * INTO result FROM public.v2_save_reading_position(room,0,3,0);
  IF NOT result.saved OR result.chunk_index<>0 OR
     result.char_offset<>3 OR result.revision<>1 THEN
    RAISE EXCEPTION 'emoji Unicode offset not persisted';
  END IF;
  SELECT * INTO result FROM public.v2_save_reading_position(room,1,2,0);
  IF result.saved OR result.chunk_index<>0 OR
     result.char_offset<>3 OR result.revision<>1 THEN
    RAISE EXCEPTION 'stale second device silently overwrote Unicode cursor';
  END IF;
  SELECT * INTO result FROM public.v2_get_reading_position(room);
  IF result.chunk_index<>0 OR result.char_offset<>3 OR
     result.revision<>1 THEN
    RAISE EXCEPTION 'private char cursor retrieval failed';
  END IF;
  SELECT * INTO result FROM public.v2_save_reading_position(room,1,2,1);
  IF NOT result.saved OR result.chunk_index<>1 OR
     result.char_offset<>2 OR result.revision<>2 THEN
    RAISE EXCEPTION 'newer revision failed to move position';
  END IF;
  -- Compatibility old API must reset the character offset.
  SELECT * INTO result FROM public.v2_save_reading_progress(room,0,2);
  IF NOT result.saved OR result.revision<>3 OR result.chunk_index<>0 THEN
    RAISE EXCEPTION 'legacy V2 save failed after Unicode migration';
  END IF;
  SELECT * INTO result FROM public.v2_get_reading_position(room);
  IF result.char_offset<>0 OR result.revision<>3 THEN
    RAISE EXCEPTION 'legacy chunk navigation retained stale char offset';
  END IF;
END $owner2$;
RESET ROLE;
INSERT INTO public.reading_members_v2(room_id,user_id,role)
VALUES(current_setting('test.position_room')::uuid,
       '00000000-0000-4000-8000-000000000002','partner');
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false);
SET ROLE authenticated;
DO $partner$
DECLARE room uuid:=current_setting('test.position_room')::uuid;
  result record;
BEGIN
  IF EXISTS(SELECT 1 FROM public.v2_get_reading_position(room)) THEN
    RAISE EXCEPTION 'partner read the owner private character position';
  END IF;
  SELECT * INTO result FROM public.v2_save_reading_position(room,0,4,0);
  IF NOT result.saved OR result.char_offset<>4 OR result.revision<>1 THEN
    RAISE EXCEPTION 'partner could not save independently';
  END IF;
END $partner$;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000003',false);
DO $outsider$
DECLARE room uuid:=current_setting('test.position_room')::uuid;
BEGIN
  IF EXISTS(SELECT 1 FROM public.v2_get_reading_position(room)) OR
     EXISTS(SELECT 1 FROM public.v2_save_reading_position(room,0,2,0)) THEN
    RAISE EXCEPTION 'stranger obtained private char position';
  END IF;
END $outsider$;
RESET ROLE;
UPDATE public.reading_rooms_v2 SET state='closed'
 WHERE id=current_setting('test.position_room')::uuid;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000000c',false);
SET ROLE authenticated;
DO $closed$
DECLARE room uuid:=current_setting('test.position_room')::uuid;
BEGIN
  IF EXISTS(SELECT 1 FROM public.v2_get_reading_position(room)) OR
     EXISTS(SELECT 1 FROM public.v2_save_reading_position(room,0,1,3)) THEN
    RAISE EXCEPTION 'closed room leaked private Unicode cursor';
  END IF;
END $closed$;
RESET ROLE;
SET ROLE anon;
DO $anon$
BEGIN
  BEGIN
    PERFORM * FROM public.v2_get_reading_position(
      current_setting('test.position_room')::uuid);
    RAISE EXCEPTION 'anonymous Unicode progress access';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $anon$;
RESET ROLE;
\echo 'PASS: Unicode character reading position, cross-device CAS, private access and legacy compatibility'
