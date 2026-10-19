\set ON_ERROR_STOP on
\ir reading_retry_v2_smoke.sql
\ir ../../supabase/migrations/20261019006000_v2_saved_bookmarks_sync.sql

INSERT INTO auth.users(id) VALUES('00000000-0000-4000-8000-00000000000b');
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000000b',false);
SET ROLE authenticated;
SELECT public.v2_create_reading_room('Independent bookmark sync') AS bookmark_room \gset
SELECT set_config('test.bookmark_room',:'bookmark_room',false);
DO $owner$
DECLARE room uuid:=current_setting('test.bookmark_room')::uuid;
  i integer; result record;
BEGIN
  FOR i IN 0..21 LOOP
    IF NOT public.v2_upload_book_chunk(room,i,'Testing private saved bookmark '||i) THEN
      RAISE EXCEPTION 'missing chunk %',i;
    END IF;
  END LOOP;
  SELECT * INTO result FROM public.v2_save_reading_progress(room,2,7);
  IF result.saved IS DISTINCT FROM false OR result.revision<>0 OR result.chunk_index IS NOT NULL THEN
    RAISE EXCEPTION 'nonzero expected revision created a missing cursor';
  END IF;
  SELECT * INTO result FROM public.v2_save_reading_progress(room,2,0);
  IF NOT result.saved OR result.chunk_index<>2 OR result.revision<>1 THEN
    RAISE EXCEPTION 'initial CAS failed';
  END IF;
  SELECT * INTO result FROM public.v2_save_reading_progress(room,3,0);
  IF result.saved OR result.revision<>1 OR result.chunk_index<>2 THEN
    RAISE EXCEPTION 'stale initial cursor overwrote saved cursor';
  END IF;
  SELECT * INTO result FROM public.v2_save_reading_progress(room,3,1);
  IF NOT result.saved OR result.revision<>2 THEN
    RAISE EXCEPTION 'current revision update failed';
  END IF;
  IF NOT public.v2_put_saved_bookmark(room,2,'章节 A') OR
     NOT public.v2_put_saved_bookmark(room,2,'章节 A（已修改）') THEN
    RAISE EXCEPTION 'bookmark create or private label update failed';
  END IF;
  IF (SELECT count(*) FROM public.v2_list_saved_bookmarks(room))<>1 THEN
    RAISE EXCEPTION 'duplicate bookmark was created';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.v2_list_saved_bookmarks(room)
     WHERE chunk_index=2 AND label='章节 A（已修改）') THEN
    RAISE EXCEPTION 'bookmark label mismatch';
  END IF;
  IF public.v2_put_saved_bookmark(room,1999,'missing') OR
     public.v2_put_saved_bookmark(room,3,repeat('x',81)) THEN
    RAISE EXCEPTION 'invalid bookmark accepted';
  END IF;
  FOR i IN 0..19 LOOP
    IF i<>2 AND NOT public.v2_put_saved_bookmark(room,i,'') THEN
      RAISE EXCEPTION 'could not reach quota 20, index %',i;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM public.v2_list_saved_bookmarks(room))<>20 THEN
    RAISE EXCEPTION 'expected quota of twenty';
  END IF;
  IF public.v2_put_saved_bookmark(room,20,'extra') THEN
    RAISE EXCEPTION 'exceeded twenty personal bookmarks';
  END IF;
  IF NOT public.v2_remove_saved_bookmark(room,2) OR
     public.v2_remove_saved_bookmark(room,2) OR
     NOT public.v2_put_saved_bookmark(room,20,'available again') THEN
    RAISE EXCEPTION 'bookmark remove did not free slot';
  END IF;
  BEGIN
    PERFORM * FROM public.reading_saved_bookmarks_v2;
    RAISE EXCEPTION 'raw private table was readable';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $owner$;
RESET ROLE;

INSERT INTO public.reading_members_v2(room_id,user_id,role)
VALUES (current_setting('test.bookmark_room')::uuid,
        '00000000-0000-4000-8000-000000000002','partner');

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false);
SET ROLE authenticated;
DO $partner$
DECLARE room uuid:=current_setting('test.bookmark_room')::uuid;
  result record;
BEGIN
  IF EXISTS(SELECT 1 FROM public.v2_list_saved_bookmarks(room)) THEN
    RAISE EXCEPTION 'partner can see owner bookmarks';
  END IF;
  IF NOT public.v2_put_saved_bookmark(room,1,'My private partner pin') THEN
    RAISE EXCEPTION 'partner cannot save independent private bookmark';
  END IF;
  IF (SELECT count(*) FROM public.v2_list_saved_bookmarks(room))<>1 THEN
    RAISE EXCEPTION 'partner saw owner pins';
  END IF;
  IF public.v2_remove_saved_bookmark(room,20) THEN
    RAISE EXCEPTION 'partner removed owner bookmark';
  END IF;
  SELECT * INTO result FROM public.v2_save_reading_progress(room,1,1);
  IF result.saved OR result.revision<>0 THEN
    RAISE EXCEPTION 'partner nonzero initial revision unexpectedly saved';
  END IF;
  SELECT * INTO result FROM public.v2_save_reading_progress(room,1,0);
  IF NOT result.saved OR result.revision<>1 THEN
    RAISE EXCEPTION 'partner cursor not independent';
  END IF;
END $partner$;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000003',false);
DO $stranger$
DECLARE room uuid:=current_setting('test.bookmark_room')::uuid;
BEGIN
  IF EXISTS(SELECT 1 FROM public.v2_list_saved_bookmarks(room)) OR
     public.v2_put_saved_bookmark(room,1,'intruder') OR
     public.v2_remove_saved_bookmark(room,1) THEN
    RAISE EXCEPTION 'stranger was given bookmark rights';
  END IF;
END $stranger$;
RESET ROLE;

DO $admin$
BEGIN
  IF (SELECT count(*) FROM public.reading_saved_bookmarks_v2
    WHERE room_id=current_setting('test.bookmark_room')::uuid)<>21 THEN
    RAISE EXCEPTION 'expected exactly 20 owner + one partner bookmark';
  END IF;
END $admin$;
UPDATE public.reading_rooms_v2 SET state='closed'
 WHERE id=current_setting('test.bookmark_room')::uuid;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000000b',false);
SET ROLE authenticated;
DO $closed$
DECLARE room uuid:=current_setting('test.bookmark_room')::uuid;
BEGIN
  IF EXISTS(SELECT 1 FROM public.v2_list_saved_bookmarks(room))
     OR public.v2_put_saved_bookmark(room,21,'closed')
     OR public.v2_remove_saved_bookmark(room,0) THEN
    RAISE EXCEPTION 'closed room exposed or mutated saved bookmarks';
  END IF;
END $closed$;
RESET ROLE;
SET ROLE anon;
DO $anonymous$
BEGIN
  BEGIN
    PERFORM * FROM public.v2_list_saved_bookmarks(
      current_setting('test.bookmark_room')::uuid);
    RAISE EXCEPTION 'anonymous read was permitted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $anonymous$;
RESET ROLE;
\echo 'PASS: independent bookmarks, quota, private RLS and strict cursor CAS'
