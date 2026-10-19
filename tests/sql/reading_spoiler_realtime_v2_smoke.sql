\set ON_ERROR_STOP on
-- Full isolated fixture includes prior SQL migrations, two-person membership,
-- presence checks, and its own controlled room closure.
\ir reading_presence_v2_smoke.sql
\ir ../../supabase/migrations/20261019160000_v2_spoiler_gate_realtime.sql

-- Reopen only the disposable test room and restore its formerly departed user.
UPDATE public.reading_rooms_v2 SET state='active'
WHERE id=current_setting('test.lifecycle_room')::uuid;
UPDATE public.reading_members_v2 SET left_at=NULL
WHERE room_id=current_setting('test.lifecycle_room')::uuid
  AND user_id='00000000-0000-4000-8000-000000000012';

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000011',false);
SET ROLE authenticated;
DO $upload$
DECLARE room uuid:=current_setting('test.lifecycle_room')::uuid;
BEGIN
  IF public.v2_upload_book_chunk(room,0,'The beginning of the book.')
    IS DISTINCT FROM true OR
     public.v2_upload_book_chunk(room,3,'The future contains a twist.')
    IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'fixture book chunks unavailable';
  END IF;
END $upload$;
-- Owned future private/shared notes; only the shared one should create a signal.
INSERT INTO public.reading_highlights_v2(
  room_id,chunk_index,author_id,start_index,end_index,body,visibility
) VALUES (
  current_setting('test.lifecycle_room')::uuid,3,
  '00000000-0000-4000-8000-000000000011',0,5,
  'PRIVATE future note','private'
);
DO $private_signal$
BEGIN
  IF EXISTS(SELECT 1 FROM public.reading_shared_signal_v2) THEN
    RAISE EXCEPTION 'private note produced a public event';
  END IF;
END $private_signal$;
INSERT INTO public.reading_highlights_v2(
  room_id,chunk_index,author_id,start_index,end_index,body,visibility
) VALUES (
  current_setting('test.lifecycle_room')::uuid,3,
  '00000000-0000-4000-8000-000000000011',0,5,
  'SPOILER: the ending','shared'
) RETURNING id AS spoiler_note \gset
SELECT set_config('test.spoiler_note',:'spoiler_note',false);
INSERT INTO public.reading_ink_v2(
  room_id,chunk_index,author_id,kind,points,visibility
) VALUES(
  current_setting('test.lifecycle_room')::uuid,3,
  '00000000-0000-4000-8000-000000000011','stroke',
  '[{"x":1,"y":1},{"x":2,"y":2}]'::jsonb,'shared'
);
DO $owner_visibility$
BEGIN
  IF (SELECT count(*) FROM public.reading_highlights_v2
      WHERE room_id=current_setting('test.lifecycle_room')::uuid)<>2
    OR (SELECT count(*) FROM public.reading_shared_signal_v2
      WHERE room_id=current_setting('test.lifecycle_room')::uuid)<>1
    OR (SELECT revision FROM public.reading_shared_signal_v2
      WHERE room_id=current_setting('test.lifecycle_room')::uuid)<>2 THEN
    RAISE EXCEPTION 'owner notes/signal revision invalid';
  END IF;
END $owner_visibility$;
RESET ROLE;

-- Partner at start: zero future shared notes/ink/replies, including raw SELECT.
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000012',false);
SET ROLE authenticated;
DO $blocked$
DECLARE room uuid:=current_setting('test.lifecycle_room')::uuid;
BEGIN
  IF EXISTS(SELECT 1 FROM public.reading_highlights_v2 WHERE room_id=room)
    OR EXISTS(SELECT 1 FROM public.reading_ink_v2 WHERE room_id=room)
    OR public.v2_can_see_shared_chunk(room,3)
    OR (SELECT count(*) FROM public.reading_shared_signal_v2 WHERE room_id=room)<>1
    OR public.v2_acknowledge_read_chunk(room,99) THEN
    RAISE EXCEPTION 'future annotation or invalid chunk exposed';
  END IF;
  IF public.v2_acknowledge_read_chunk(room,0) IS DISTINCT FROM true
    OR public.v2_can_see_shared_chunk(room,3) THEN
    RAISE EXCEPTION 'starting page unlocked future';
  END IF;
END $blocked$;
-- Explicitly opening chunk 3 reveals only shared material through that index.
DO $unlocked$
DECLARE room uuid:=current_setting('test.lifecycle_room')::uuid;
BEGIN
  IF public.v2_acknowledge_read_chunk(room,3) IS DISTINCT FROM true OR
     (SELECT count(*) FROM public.reading_highlights_v2
       WHERE room_id=room)<>1 OR
     (SELECT count(*) FROM public.reading_ink_v2
       WHERE room_id=room)<>1 THEN
    RAISE EXCEPTION 'explicitly revealed shared context not visible';
  END IF;
  IF EXISTS(SELECT 1 FROM public.reading_highlights_v2
    WHERE room_id=room AND body LIKE 'PRIVATE%') THEN
    RAISE EXCEPTION 'private note revealed';
  END IF;
  IF public.v2_acknowledge_read_chunk(room,0) IS DISTINCT FROM true
    OR NOT public.v2_can_see_shared_chunk(room,3) THEN
    RAISE EXCEPTION 'reading backwards revoked a prior explicit reveal';
  END IF;
END $unlocked$;
-- Reply on future note can be shared only after the page is opened.
SELECT public.v2_submit_reply(current_setting('test.lifecycle_room')::uuid,
  current_setting('test.spoiler_note')::uuid, 'I reached this chapter.',
  '90000000-0000-4000-8000-000000000010') AS reply_status \gset
DO $reply_signal$
BEGIN
  IF (SELECT count(*) FROM public.reading_note_replies_v2
       WHERE room_id=current_setting('test.lifecycle_room')::uuid)<>1
    OR (SELECT revision FROM public.reading_shared_signal_v2
       WHERE room_id=current_setting('test.lifecycle_room')::uuid)<>3 THEN
    RAISE EXCEPTION 'shared reply or notification missing';
  END IF;
END $reply_signal$;
-- No ordinary table mutations of the frontier or shared event.
DO $no_direct_writes$
BEGIN
  BEGIN
    UPDATE public.reading_shared_signal_v2 SET revision=999;
    RAISE EXCEPTION 'client changed protected signal';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.reading_spoiler_frontier_v2
      (room_id,user_id,revealed_through)
    VALUES(current_setting('test.lifecycle_room')::uuid,
      '00000000-0000-4000-8000-000000000012',1999);
    RAISE EXCEPTION 'client forged future frontier';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $no_direct_writes$;
RESET ROLE;

-- Member exit revokes all future shared, private, signal, and frontier access.
UPDATE public.reading_members_v2 SET left_at=pg_catalog.now()
WHERE room_id=current_setting('test.lifecycle_room')::uuid
  AND user_id='00000000-0000-4000-8000-000000000012';
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000012',false);
SET ROLE authenticated;
DO $revoked$
DECLARE room uuid:=current_setting('test.lifecycle_room')::uuid;
BEGIN
  IF public.v2_acknowledge_read_chunk(room,3) OR
     public.v2_can_see_shared_chunk(room,3) OR
     EXISTS(SELECT 1 FROM public.reading_highlights_v2 WHERE room_id=room)
     OR EXISTS(SELECT 1 FROM public.reading_note_replies_v2 WHERE room_id=room)
     OR EXISTS(SELECT 1 FROM public.reading_ink_v2 WHERE room_id=room)
     OR EXISTS(SELECT 1 FROM public.reading_shared_signal_v2 WHERE room_id=room)
     THEN RAISE EXCEPTION 'revoked member retained spoiler access';
  END IF;
END $revoked$;
RESET ROLE;

-- Anonymous cannot call privileged unlock functions or select signal rows.
SET ROLE anon;
DO $anonymous$
BEGIN
  BEGIN
    PERFORM public.v2_acknowledge_read_chunk(current_setting('test.lifecycle_room')::uuid,3);
    RAISE EXCEPTION 'anonymous unlock executed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF EXISTS(SELECT 1 FROM public.reading_shared_signal_v2) THEN
    RAISE EXCEPTION 'anonymous activity leaked';
  END IF;
END $anonymous$;
RESET ROLE;
\echo 'PASS: spoiler RLS, private notes, drawing, guarded replies, opaque signals, member revocation'
