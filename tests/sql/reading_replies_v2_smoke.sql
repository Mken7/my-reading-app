\set ON_ERROR_STOP on
\ir reading_ink_v2_smoke.sql
\ir ../../supabase/migrations/20261019002000_v2_note_replies.sql

INSERT INTO auth.users (id) VALUES ('00000000-0000-4000-8000-000000000007');
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000007',false);
SET ROLE authenticated;
SELECT public.v2_create_reading_room('Note replies privacy') AS reply_room \gset
SELECT set_config('test.reply_room',:'reply_room',false);
DO $owner$
BEGIN
  IF NOT public.v2_upload_book_chunk(
    current_setting('test.reply_room')::uuid,0,'这是共读与私人批注') THEN
    RAISE EXCEPTION 'book chunk upload failed';
  END IF;
  INSERT INTO public.reading_highlights_v2
    (room_id,chunk_index,author_id,start_index,end_index,body,visibility)
  VALUES (
    current_setting('test.reply_room')::uuid,0,
    '00000000-0000-4000-8000-000000000007',
    0,2,'public reflection','shared'
  ), (
    current_setting('test.reply_room')::uuid,0,
    '00000000-0000-4000-8000-000000000007',
    2,4,'private reflection','private'
  );
END $owner$;
RESET ROLE;

SELECT id AS shared_id FROM public.reading_highlights_v2
WHERE room_id=current_setting('test.reply_room')::uuid AND visibility='shared' \gset
SELECT id AS private_id FROM public.reading_highlights_v2
WHERE room_id=current_setting('test.reply_room')::uuid AND visibility='private' \gset
SELECT set_config('test.shared_id',:'shared_id',false);
SELECT set_config('test.private_id',:'private_id',false);

INSERT INTO public.reading_members_v2(room_id,user_id,role)
VALUES(current_setting('test.reply_room')::uuid,
       '00000000-0000-4000-8000-000000000002','partner');

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000007',false);
SET ROLE authenticated;
DO $first$
BEGIN
  INSERT INTO public.reading_note_replies_v2 (
    room_id,highlight_id,author_id,body
  ) VALUES (
    current_setting('test.reply_room')::uuid,
    current_setting('test.shared_id')::uuid,
    '00000000-0000-4000-8000-000000000007',
    'owner shared response'
  ), (
    current_setting('test.reply_room')::uuid,
    current_setting('test.private_id')::uuid,
    '00000000-0000-4000-8000-000000000007',
    'owner private response'
  );
  IF (SELECT count(*) FROM public.reading_note_replies_v2
    WHERE room_id=current_setting('test.reply_room')::uuid) <> 2 THEN
    RAISE EXCEPTION 'owner cannot read their two replies';
  END IF;
  BEGIN
    UPDATE public.reading_note_replies_v2 SET body='tampered';
    RAISE EXCEPTION 'client can edit old reply';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $first$;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false);
DO $partner$
BEGIN
  IF (SELECT count(*) FROM public.reading_note_replies_v2
    WHERE room_id=current_setting('test.reply_room')::uuid)<>1 THEN
    RAISE EXCEPTION 'partner can read private reply';
  END IF;
  BEGIN
    INSERT INTO public.reading_note_replies_v2 (
      room_id,highlight_id,author_id,body
    ) VALUES(
      current_setting('test.reply_room')::uuid,
      current_setting('test.private_id')::uuid,
      '00000000-0000-4000-8000-000000000002',
      'unauthorized message'
    );
    RAISE EXCEPTION 'partner could reply to a private note';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  INSERT INTO public.reading_note_replies_v2 (
    room_id,highlight_id,author_id,body
  ) VALUES(
    current_setting('test.reply_room')::uuid,
    current_setting('test.shared_id')::uuid,
    '00000000-0000-4000-8000-000000000002',
    'partner shared reply'
  );
  IF (SELECT count(*) FROM public.reading_note_replies_v2
    WHERE room_id=current_setting('test.reply_room')::uuid)<>2 THEN
    RAISE EXCEPTION 'partner cannot see both shared replies';
  END IF;
END $partner$;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000003',false);
DO $outsider$
BEGIN
  IF EXISTS (SELECT 1 FROM public.reading_note_replies_v2) THEN
    RAISE EXCEPTION 'third user can enumerate replies';
  END IF;
  BEGIN
    INSERT INTO public.reading_note_replies_v2 (
      room_id,highlight_id,author_id,body
    ) VALUES(
      current_setting('test.reply_room')::uuid,
      current_setting('test.shared_id')::uuid,
      '00000000-0000-4000-8000-000000000003',
      'stranger'
    );
    RAISE EXCEPTION 'stranger wrote reply';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $outsider$;
RESET ROLE;

DO $audit$
DECLARE
  event public.reading_audit_v2%ROWTYPE;
  last_hash text := repeat('0',64);
  n integer := 0;
  expected text;
BEGIN
  FOR event IN SELECT * FROM public.reading_audit_v2
    WHERE room_id=current_setting('test.reply_room')::uuid
    ORDER BY sequence_number LOOP
    n := n + 1;
    IF event.sequence_number<>n OR event.previous_hash<>last_hash THEN
      RAISE EXCEPTION 'reply audit chain invalid';
    END IF;
    expected:=encode(sha256(convert_to(
      jsonb_build_object('version',1,'room',event.room_id,
        'sequence',event.sequence_number,'actor',event.actor_id,
        'kind',event.action,'note',event.note_id,
        'payload_hash',event.payload_hash,'previous_hash',event.previous_hash,
        'occurred_at',event.occurred_at)::text,'UTF8')),'hex');
    IF expected<>event.event_hash THEN
      RAISE EXCEPTION 'reply event hash failed';
    END IF;
    last_hash:=event.event_hash;
  END LOOP;
  IF n<>5 THEN RAISE EXCEPTION 'expected 5 events (2 notes + 3 replies), got %',n; END IF;
END $audit$;

UPDATE public.reading_rooms_v2 SET state='closed'
WHERE id=current_setting('test.reply_room')::uuid;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false);
SET ROLE authenticated;
DO $closed$
BEGIN
  BEGIN
    INSERT INTO public.reading_note_replies_v2 (
      room_id,highlight_id,author_id,body
    ) VALUES(
      current_setting('test.reply_room')::uuid,
      current_setting('test.shared_id')::uuid,
      '00000000-0000-4000-8000-000000000002',
      'closed room reply'
    );
    RAISE EXCEPTION 'closed room accepted reply';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $closed$;
RESET ROLE;
\echo 'PASS: visibility-inherited replies, independent authors and room audit'
