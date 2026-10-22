\set ON_ERROR_STOP on
\ir reading_progress_v2_smoke.sql
\ir ../../supabase/migrations/20261018235000_v2_overlap_annotations.sql

INSERT INTO auth.users(id) VALUES('00000000-0000-4000-8000-000000000005');
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000005',false);
SET ROLE authenticated;
SELECT public.v2_create_reading_room('Overlapping annotations') AS overlap_room \gset
SELECT set_config('test.overlap_room',:'overlap_room',false);
DO $first$
BEGIN
  IF NOT public.v2_upload_book_chunk(
    current_setting('test.overlap_room')::uuid,0,'甲乙丙😀丁') THEN
    RAISE EXCEPTION 'overlap text upload failed';
  END IF;
  INSERT INTO public.reading_highlights_v2
    (room_id,chunk_index,author_id,start_index,end_index,body,visibility)
  VALUES
    (current_setting('test.overlap_room')::uuid,0,
     '00000000-0000-4000-8000-000000000005',0,4,'shared owner remark','shared');
  BEGIN
    INSERT INTO public.reading_highlights_v2
      (room_id,chunk_index,author_id,start_index,end_index,body,visibility)
    VALUES(current_setting('test.overlap_room')::uuid,0,
      '00000000-0000-4000-8000-000000000005',1,6,'bad anchor','shared');
    RAISE EXCEPTION 'invalid Unicode codepoint offset accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM 1 FROM public.reading_audit_v2;
    RAISE EXCEPTION 'client can inspect private audit log';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $first$;
RESET ROLE;

INSERT INTO public.reading_members_v2(room_id,user_id,role)
VALUES(current_setting('test.overlap_room')::uuid,
       '00000000-0000-4000-8000-000000000002','partner');

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false);
SET ROLE authenticated;
DO $partner$
BEGIN
  -- User B's overlapping interval 2..5 intersects owner 0..4;
  -- independent ranges coexist without an exclusion constraint.
  INSERT INTO public.reading_highlights_v2
    (room_id,chunk_index,author_id,start_index,end_index,body,visibility)
  VALUES
    (current_setting('test.overlap_room')::uuid,0,
      '00000000-0000-4000-8000-000000000002',2,5,'shared partner remark','shared'),
    (current_setting('test.overlap_room')::uuid,0,
      '00000000-0000-4000-8000-000000000002',0,2,'private partner remark','private');
  IF (SELECT count(*) FROM public.reading_highlights_v2) <> 3 THEN
    RAISE EXCEPTION 'partner cannot read shared + own private';
  END IF;
  BEGIN
    UPDATE public.reading_highlights_v2
    SET start_index=1 WHERE body='shared partner remark';
    RAISE EXCEPTION 'annotation anchor could be forged';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $partner$;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000005',false);
DO $owner$
BEGIN
  IF (SELECT count(*) FROM public.reading_highlights_v2) <> 2 THEN
    RAISE EXCEPTION 'owner can read partner private annotation';
  END IF;
  IF EXISTS(SELECT 1 FROM public.reading_highlights_v2
            WHERE body='private partner remark') THEN
    RAISE EXCEPTION 'private partner content leaked';
  END IF;
  UPDATE public.reading_highlights_v2
    SET body='edited shared owner remark'
  WHERE body='shared owner remark';
  IF (SELECT revision FROM public.reading_highlights_v2
      WHERE body='edited shared owner remark') <> 2 THEN
    RAISE EXCEPTION 'annotation revision was not incremented';
  END IF;
END $owner$;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000003',false);
DO $outsider$
BEGIN
  IF EXISTS(SELECT 1 FROM public.reading_highlights_v2) THEN
    RAISE EXCEPTION 'third person read annotation content';
  END IF;
  BEGIN
    INSERT INTO public.reading_highlights_v2
      (room_id,chunk_index,author_id,start_index,end_index,body,visibility)
    VALUES(current_setting('test.overlap_room')::uuid,0,
      '00000000-0000-4000-8000-000000000003',0,2,'stranger','shared');
    RAISE EXCEPTION 'outsider wrote room annotation';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $outsider$;
RESET ROLE;

DO $audit$
DECLARE
  row public.reading_audit_v2%ROWTYPE;
  prev_hash text := repeat('0',64);
  expected_hash text;
  n integer := 0;
BEGIN
  FOR row IN SELECT * FROM public.reading_audit_v2
    WHERE room_id=current_setting('test.overlap_room')::uuid
    ORDER BY sequence_number
  LOOP
    n:=n+1;
    IF row.sequence_number<>n OR row.previous_hash<>prev_hash
       OR row.action NOT LIKE 'highlight.%' THEN
      RAISE EXCEPTION 'overlap audit chain broken';
    END IF;
    expected_hash:=encode(sha256(convert_to(
      jsonb_build_object(
        'version',1,'room',row.room_id,'sequence',row.sequence_number,
        'actor',row.actor_id,'kind',row.action,'note',row.note_id,
        'payload_hash',row.payload_hash,'previous_hash',row.previous_hash,
        'occurred_at',row.occurred_at
      )::text,'UTF8')),'hex');
    IF row.event_hash<>expected_hash THEN
      RAISE EXCEPTION 'overlap audit digest invalid';
    END IF;
    prev_hash:=row.event_hash;
  END LOOP;
  IF n<>4 THEN RAISE EXCEPTION 'expected 4 annotation events; got %',n; END IF;
END $audit$;

UPDATE public.reading_rooms_v2 SET state='closed'
WHERE id=current_setting('test.overlap_room')::uuid;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false);
SET ROLE authenticated;
DO $closed$
BEGIN
  BEGIN
    INSERT INTO public.reading_highlights_v2
      (room_id,chunk_index,author_id,start_index,end_index,body,visibility)
    VALUES(current_setting('test.overlap_room')::uuid,0,
      '00000000-0000-4000-8000-000000000002',0,1,'closed room','shared');
    RAISE EXCEPTION 'closed room accepted annotation';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $closed$;
RESET ROLE;
\echo 'PASS: overlapping member annotations, private visibility and audit linkage'
