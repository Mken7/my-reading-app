\set ON_ERROR_STOP on
\ir reading_annotations_v2_smoke.sql
\ir ../../supabase/migrations/20261019001000_v2_ink.sql

INSERT INTO auth.users (id) VALUES ('00000000-0000-4000-8000-000000000006');
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000006',false);
SET ROLE authenticated;
SELECT public.v2_create_reading_room('Ink overlap regression') AS ink_room \gset
SELECT set_config('test.ink_room',:'ink_room',false);
DO $owner$
BEGIN
  IF NOT public.v2_upload_book_chunk(
      current_setting('test.ink_room')::uuid,0,'测试手写、箭头和圈注') THEN
    RAISE EXCEPTION 'upload failed for ink test';
  END IF;
  INSERT INTO public.reading_ink_v2 (
    room_id,chunk_index,author_id,kind,points,visibility
  ) VALUES (
    current_setting('test.ink_room')::uuid,0,
    '00000000-0000-4000-8000-000000000006','ellipse',
    '[{"x":100,"y":150},{"x":800,"y":850}]','shared'
  );
  INSERT INTO public.reading_ink_v2 (
    room_id,chunk_index,author_id,kind,points,visibility
  ) VALUES (
    current_setting('test.ink_room')::uuid,0,
    '00000000-0000-4000-8000-000000000006','stroke',
    '[{"x":0,"y":0},{"x":300,"y":350},{"x":900,"y":900}]','private'
  );

  BEGIN
    INSERT INTO public.reading_ink_v2(
      room_id,chunk_index,author_id,kind,points,visibility
    ) VALUES (
      current_setting('test.ink_room')::uuid,0,
      '00000000-0000-4000-8000-000000000006','stroke',
      '[{"x":-1,"y":12},{"x":18,"y":20}]','shared'
    );
    RAISE EXCEPTION 'accepted negative coordinate';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.reading_ink_v2(
      room_id,chunk_index,author_id,kind,points,visibility
    ) VALUES (
      current_setting('test.ink_room')::uuid,0,
      '00000000-0000-4000-8000-000000000006','arrow',
      '[{"x":1,"y":1},{"x":2,"y":2},{"x":3,"y":3}]','shared'
    );
    RAISE EXCEPTION 'accepted malformed arrow';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.reading_ink_v2(
      room_id,chunk_index,author_id,kind,points,visibility
    ) VALUES (
      current_setting('test.ink_room')::uuid,0,
      '00000000-0000-4000-8000-000000000006','ellipse',
      '[{"x":1,"y":1},{"y":2}]','shared'
    );
    RAISE EXCEPTION 'accepted missing x coordinate';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.reading_ink_v2 SET visibility='shared'
    WHERE visibility='private';
    RAISE EXCEPTION 'client could modify immutable ink';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM 1 FROM public.reading_audit_v2;
    RAISE EXCEPTION 'client can read audit chain';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $owner$;
RESET ROLE;

INSERT INTO public.reading_members_v2(room_id,user_id,role)
VALUES(current_setting('test.ink_room')::uuid,
       '00000000-0000-4000-8000-000000000002','partner');

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false);
SET ROLE authenticated;
DO $partner$
BEGIN
  INSERT INTO public.reading_ink_v2(
    room_id,chunk_index,author_id,kind,points,visibility
  ) VALUES (
    current_setting('test.ink_room')::uuid,0,
    '00000000-0000-4000-8000-000000000002','arrow',
    '[{"x":180,"y":200},{"x":850,"y":870}]','shared'
  );
  INSERT INTO public.reading_ink_v2(
    room_id,chunk_index,author_id,kind,points,visibility
  ) VALUES (
    current_setting('test.ink_room')::uuid,0,
    '00000000-0000-4000-8000-000000000002','stroke',
    '[{"x":111,"y":222},{"x":333,"y":444}]','private'
  );
  IF (SELECT count(*) FROM public.reading_ink_v2
      WHERE room_id=current_setting('test.ink_room')::uuid)<>3 THEN
    RAISE EXCEPTION 'partner visibility wrong: expected two shared + own private';
  END IF;
END $partner$;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000006',false);
DO $owner2$
BEGIN
  IF (SELECT count(*) FROM public.reading_ink_v2
      WHERE room_id=current_setting('test.ink_room')::uuid)<>3 THEN
    RAISE EXCEPTION 'owner visibility wrong: own two + partner shared';
  END IF;
  IF EXISTS(
    SELECT 1 FROM public.reading_ink_v2
    WHERE author_id='00000000-0000-4000-8000-000000000002'
      AND visibility='private'
  ) THEN
    RAISE EXCEPTION 'partner private ink leaked';
  END IF;
END $owner2$;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000003',false);
DO $outsider$
BEGIN
  IF EXISTS(SELECT 1 FROM public.reading_ink_v2) THEN
    RAISE EXCEPTION 'stranger can read ink';
  END IF;
  BEGIN
    INSERT INTO public.reading_ink_v2(
      room_id,chunk_index,author_id,kind,points,visibility
    ) VALUES (
      current_setting('test.ink_room')::uuid,0,
      '00000000-0000-4000-8000-000000000003','arrow',
      '[{"x":0,"y":0},{"x":1000,"y":1000}]','shared'
    );
    RAISE EXCEPTION 'stranger wrote ink';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $outsider$;
RESET ROLE;

DO $audit$
DECLARE
  row public.reading_audit_v2%ROWTYPE;
  head text := repeat('0',64);
  expected text;
  total integer := 0;
BEGIN
  FOR row IN SELECT * FROM public.reading_audit_v2
    WHERE room_id=current_setting('test.ink_room')::uuid
    ORDER BY sequence_number LOOP
    total:=total+1;
    IF row.sequence_number <> total OR row.previous_hash<>head OR
       row.action<>'ink.created' THEN
      RAISE EXCEPTION 'ink audit chain broken';
    END IF;
    expected:=encode(sha256(convert_to(
      jsonb_build_object('version',1,'room',row.room_id,
        'sequence',row.sequence_number,'actor',row.actor_id,
        'kind',row.action,'note',row.note_id,
        'payload_hash',row.payload_hash,'previous_hash',row.previous_hash,
        'occurred_at',row.occurred_at)::text,'UTF8')),'hex');
    IF expected<>row.event_hash THEN
      RAISE EXCEPTION 'ink audit hash validation failed';
    END IF;
    head:=row.event_hash;
  END LOOP;
  IF total<>4 THEN RAISE EXCEPTION 'expected 4 ink events, got %',total; END IF;
END $audit$;

UPDATE public.reading_rooms_v2 SET state='closed'
WHERE id=current_setting('test.ink_room')::uuid;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false);
SET ROLE authenticated;
DO $closed$
BEGIN
  BEGIN
    INSERT INTO public.reading_ink_v2(
      room_id,chunk_index,author_id,kind,points,visibility
    ) VALUES (
      current_setting('test.ink_room')::uuid,0,
      '00000000-0000-4000-8000-000000000002','stroke',
      '[{"x":0,"y":0},{"x":50,"y":50}]','shared'
    );
    RAISE EXCEPTION 'closed room accepted drawing';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $closed$;
RESET ROLE;
\echo 'PASS: independent overlapping ink, strict shape limits, privacy and audit'
