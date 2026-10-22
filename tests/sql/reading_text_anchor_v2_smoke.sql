\set ON_ERROR_STOP on
\ir reading_replies_v2_smoke.sql
\ir ../../supabase/migrations/20261019003000_v2_text_relative_ink.sql

INSERT INTO auth.users (id) VALUES ('00000000-0000-4000-8000-000000000008');
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000008',false);
SET ROLE authenticated;
SELECT public.v2_create_reading_room('Anchored ink test') AS anchored_room \gset
SELECT set_config('test.anchored_room',:'anchored_room',false);
DO $owner$
BEGIN
  IF NOT public.v2_upload_book_chunk(
    current_setting('test.anchored_room')::uuid,0,'甲😀乙🐈丙') THEN
    RAISE EXCEPTION 'upload failed';
  END IF;

  INSERT INTO public.reading_ink_v2 (
    room_id,chunk_index,author_id,kind,points,visibility,
    anchor_start,anchor_end
  ) VALUES (
    current_setting('test.anchored_room')::uuid,0,
    '00000000-0000-4000-8000-000000000008',
    'ellipse','[{"x":50,"y":50},{"x":950,"y":950}]','shared',1,4
  );

  -- Existing legacy paragraph-relative shapes stay valid.
  INSERT INTO public.reading_ink_v2 (
    room_id,chunk_index,author_id,kind,points,visibility
  ) VALUES (
    current_setting('test.anchored_room')::uuid,0,
    '00000000-0000-4000-8000-000000000008',
    'stroke','[{"x":1,"y":1},{"x":999,"y":999}]','private'
  );

  BEGIN
    INSERT INTO public.reading_ink_v2 (
      room_id,chunk_index,author_id,kind,points,visibility,
      anchor_start,anchor_end
    ) VALUES (
      current_setting('test.anchored_room')::uuid,0,
      '00000000-0000-4000-8000-000000000008',
      'arrow','[{"x":50,"y":50},{"x":950,"y":950}]','shared',1,6
    );
    RAISE EXCEPTION 'anchor accepted beyond Unicode text';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.reading_ink_v2 (
      room_id,chunk_index,author_id,kind,points,visibility,
      anchor_start,anchor_end
    ) VALUES (
      current_setting('test.anchored_room')::uuid,0,
      '00000000-0000-4000-8000-000000000008',
      'arrow','[{"x":50,"y":50},{"x":950,"y":950}]','shared',NULL,3
    );
    RAISE EXCEPTION 'accepted only one anchor endpoint';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $owner$;
RESET ROLE;

INSERT INTO public.reading_members_v2(room_id,user_id,role)
VALUES(current_setting('test.anchored_room')::uuid,
       '00000000-0000-4000-8000-000000000002','partner');

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false);
SET ROLE authenticated;
DO $partner$
BEGIN
  IF (SELECT count(*) FROM public.reading_ink_v2
      WHERE room_id=current_setting('test.anchored_room')::uuid)<>1 THEN
    RAISE EXCEPTION 'private legacy ink leaked';
  END IF;
  INSERT INTO public.reading_ink_v2 (
    room_id,chunk_index,author_id,kind,points,visibility,
    anchor_start,anchor_end
  ) VALUES (
    current_setting('test.anchored_room')::uuid,0,
    '00000000-0000-4000-8000-000000000002',
    'arrow','[{"x":0,"y":0},{"x":999,"y":999}]','shared',2,5
  );
END $partner$;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000003',false);
DO $outsider$
BEGIN
  IF EXISTS(SELECT 1 FROM public.reading_ink_v2
    WHERE room_id=current_setting('test.anchored_room')::uuid) THEN
    RAISE EXCEPTION 'outsider saw text-anchored strokes';
  END IF;
END $outsider$;
RESET ROLE;

DO $audit$
DECLARE
  event public.reading_audit_v2%ROWTYPE;
  ink public.reading_ink_v2%ROWTYPE;
  expected text;
BEGIN
  SELECT * INTO ink FROM public.reading_ink_v2
  WHERE room_id=current_setting('test.anchored_room')::uuid
    AND anchor_start=1;
  SELECT * INTO event FROM public.reading_audit_v2
  WHERE room_id=ink.room_id AND note_id=ink.id AND action='ink.created';
  expected:=encode(sha256(convert_to(
    jsonb_build_object(
      'version',2,'id',ink.id,'room',ink.room_id,'chunk',ink.chunk_index,
      'author',ink.author_id,'kind',ink.kind,'points',ink.points,
      'visibility',ink.visibility,'created_at',ink.created_at,
      'anchor_start',ink.anchor_start,'anchor_end',ink.anchor_end
    )::text,'UTF8')),'hex');
  IF event.payload_hash IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'text anchor not covered by audit digest';
  END IF;
  IF (SELECT count(*) FROM public.reading_audit_v2
      WHERE room_id=ink.room_id)<>3 THEN
    RAISE EXCEPTION 'expected 3 ink audit events';
  END IF;
END $audit$;
\echo 'PASS: anchored ink preserves old rows, validates Unicode ranges and audit metadata'
