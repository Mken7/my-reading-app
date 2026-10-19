\set ON_ERROR_STOP on
\ir reading_character_position_v2_smoke.sql
\ir ../../supabase/migrations/20261019008000_v2_ink_reflow_policy.sql

INSERT INTO auth.users(id) VALUES('00000000-0000-4000-8000-00000000000d');
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000000d',false);
SET ROLE authenticated;
SELECT public.v2_create_reading_room('Reflow safe ink test') AS reflow_room \gset
SELECT set_config('test.reflow_room',:'reflow_room',false);

DO $owner$
DECLARE
  room uuid:=current_setting('test.reflow_room')::uuid;
BEGIN
  IF NOT public.v2_upload_book_chunk(room,0,'第一行你好😀世界，第二行测试') THEN
    RAISE EXCEPTION 'failed to upload ink text';
  END IF;

  INSERT INTO public.reading_ink_v2(
    room_id,chunk_index,author_id,kind,points,visibility,
    anchor_start,anchor_end,anchor_layout
  ) VALUES(room,0,'00000000-0000-4000-8000-00000000000d',
    'ellipse','[{"x":100,"y":100},{"x":900,"y":900}]',
    'shared',2,6,'single_line_v2');

  INSERT INTO public.reading_ink_v2(
    room_id,chunk_index,author_id,kind,points,visibility,
    anchor_start,anchor_end,anchor_layout
  ) VALUES(room,0,'00000000-0000-4000-8000-00000000000d',
    'arrow','[{"x":100,"y":100},{"x":900,"y":900}]',
    'private',6,9,'single_line_v2');

  INSERT INTO public.reading_ink_v2(
    room_id,chunk_index,author_id,kind,points,visibility
  ) VALUES(room,0,'00000000-0000-4000-8000-00000000000d',
    'stroke','[{"x":10,"y":50},{"x":900,"y":60}]','shared');

  IF (SELECT count(*) FROM public.reading_ink_v2
    WHERE room_id=room AND anchor_layout='bounding_v1')<>1 THEN
    RAISE EXCEPTION 'old paragraph-relative strokes not compatible';
  END IF;

  BEGIN
    INSERT INTO public.reading_ink_v2(
      room_id,chunk_index,author_id,kind,points,visibility,
      anchor_layout
    ) VALUES(room,0,'00000000-0000-4000-8000-00000000000d',
      'arrow','[{"x":100,"y":100},{"x":900,"y":900}]','shared',
      'single_line_v2');
    RAISE EXCEPTION 'unanchored single-line ink accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.reading_ink_v2(
      room_id,chunk_index,author_id,kind,points,visibility,
      anchor_start,anchor_end,anchor_layout
    ) VALUES(room,0,'00000000-0000-4000-8000-00000000000d',
      'ellipse','[{"x":100,"y":100},{"x":900,"y":900}]',
      'private',0,2,'unsupported_mode');
    RAISE EXCEPTION 'unexpected layout string accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $owner$;
RESET ROLE;
INSERT INTO public.reading_members_v2(room_id,user_id,role)
VALUES(current_setting('test.reflow_room')::uuid,
  '00000000-0000-4000-8000-000000000002','partner');

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false);
SET ROLE authenticated;
DO $partner$
DECLARE room uuid:=current_setting('test.reflow_room')::uuid;
BEGIN
  IF (SELECT count(*) FROM public.reading_ink_v2
      WHERE room_id=room)<>2 THEN
    RAISE EXCEPTION 'partner saw owner private stroke or lost shared strokes';
  END IF;
  INSERT INTO public.reading_ink_v2(
    room_id,chunk_index,author_id,kind,points,visibility,
    anchor_start,anchor_end,anchor_layout
  ) VALUES(room,0,'00000000-0000-4000-8000-000000000002',
    'arrow','[{"x":100,"y":100},{"x":900,"y":900}]',
    'shared',0,2,'single_line_v2');
  IF public.v2_hide_ink(room,(
    SELECT i.id FROM public.reading_ink_v2 i
    WHERE i.room_id=room AND i.author_id='00000000-0000-4000-8000-00000000000d'
      AND i.visibility='shared' ORDER BY i.created_at LIMIT 1
  )) THEN
    RAISE EXCEPTION 'partner hid owner shared stroke';
  END IF;
END $partner$;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000003',false);
DO $outsider$
DECLARE room uuid:=current_setting('test.reflow_room')::uuid;
BEGIN
  IF EXISTS(SELECT 1 FROM public.reading_ink_v2 WHERE room_id=room) THEN
    RAISE EXCEPTION 'outsider saw ink';
  END IF;
END $outsider$;
RESET ROLE;

DO $audit$
DECLARE record_value public.reading_ink_v2%ROWTYPE;
  audit_event public.reading_audit_v2%ROWTYPE;
  expected text;
BEGIN
  SELECT * INTO record_value FROM public.reading_ink_v2
  WHERE room_id=current_setting('test.reflow_room')::uuid
    AND anchor_layout='single_line_v2'
  ORDER BY created_at LIMIT 1;
  SELECT * INTO audit_event FROM public.reading_audit_v2
    WHERE note_id=record_value.id AND action='ink.created';
  expected:=encode(sha256(convert_to(jsonb_build_object(
    'version',3,'id',record_value.id,'room',record_value.room_id,
    'chunk',record_value.chunk_index,'author',record_value.author_id,
    'kind',record_value.kind,'points',record_value.points,
    'visibility',record_value.visibility,'created_at',record_value.created_at,
    'anchor_start',record_value.anchor_start,'anchor_end',record_value.anchor_end,
    'anchor_layout',record_value.anchor_layout
  )::text,'UTF8')),'hex');
  IF expected IS DISTINCT FROM audit_event.payload_hash THEN
    RAISE EXCEPTION 'single-line layout mode absent from audit payload';
  END IF;
END $audit$;

UPDATE public.reading_rooms_v2 SET state='closed'
  WHERE id=current_setting('test.reflow_room')::uuid;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000000d',false);
SET ROLE authenticated;
DO $closed$
BEGIN
  IF EXISTS(SELECT 1 FROM public.reading_ink_v2 i
      WHERE i.room_id=current_setting('test.reflow_room')::uuid) THEN
    RAISE EXCEPTION 'closed room still exposed personally authored ink';
  END IF;
END $closed$;
RESET ROLE;
\echo 'PASS: anchored layout modes, audit integrity, partner visibility and closed room revocation'
