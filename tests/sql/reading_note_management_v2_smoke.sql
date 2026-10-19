\set ON_ERROR_STOP on
\ir reading_ink_reflow_v2_smoke.sql
\ir ../../supabase/migrations/20261019009000_v2_note_management.sql

INSERT INTO auth.users(id) VALUES('00000000-0000-4000-8000-00000000000e');
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000000e',false);
SET ROLE authenticated;
SELECT public.v2_create_reading_room('Note edit hide privacy') AS note_room \gset
SELECT set_config('test.note_room',:'note_room',false);

DO $owner$
DECLARE room uuid:=current_setting('test.note_room')::uuid;
BEGIN
  IF NOT public.v2_upload_book_chunk(room,0,'甲😀乙🐈丙') THEN
    RAISE EXCEPTION 'failed to upload immutable note paragraph';
  END IF;
  IF public.v2_submit_highlight(room,0,1,4,'private initial','private',
     'eeeeeeee-0000-4000-8000-000000000001')<>'saved'
    OR public.v2_submit_highlight(room,0,0,5,'shared initial','shared',
     'eeeeeeee-0000-4000-8000-000000000002')<>'saved' THEN
    RAISE EXCEPTION 'initial independent notes failed';
  END IF;
END $owner$;
RESET ROLE;

SELECT id AS note_private_id FROM public.reading_highlights_v2
WHERE room_id=current_setting('test.note_room')::uuid
AND client_operation_id='eeeeeeee-0000-4000-8000-000000000001' \gset
SELECT set_config('test.note_private_id',:'note_private_id',false);
SELECT id AS note_shared_id FROM public.reading_highlights_v2
WHERE room_id=current_setting('test.note_room')::uuid
AND client_operation_id='eeeeeeee-0000-4000-8000-000000000002' \gset
SELECT set_config('test.note_shared_id',:'note_shared_id',false);

INSERT INTO public.reading_members_v2(room_id,user_id,role)
VALUES(current_setting('test.note_room')::uuid,
       '00000000-0000-4000-8000-000000000002','partner');

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false);
SET ROLE authenticated;
DO $partner$
DECLARE room uuid:=current_setting('test.note_room')::uuid;
  private_note uuid:=current_setting('test.note_private_id')::uuid;
  shared_note uuid:=current_setting('test.note_shared_id')::uuid;
BEGIN
  IF (SELECT count(*) FROM public.reading_highlights_v2
     WHERE room_id=room)<>1 THEN
    RAISE EXCEPTION 'private note readable by partner';
  END IF;
  IF public.v2_edit_highlight(room,shared_note,'tampered','shared',1)<>'denied'
     OR public.v2_hide_highlight(room,shared_note) THEN
    RAISE EXCEPTION 'partner edited or hid owner note';
  END IF;
  IF public.v2_submit_reply(room,private_note,'private leak',
      'eeeeeeee-0000-4000-8000-000000000003')<>'denied' THEN
    RAISE EXCEPTION 'partner replied to owner private note';
  END IF;
  IF public.v2_submit_reply(room,shared_note,'partner discussion',
      'eeeeeeee-0000-4000-8000-000000000004')<>'saved' THEN
    RAISE EXCEPTION 'partner could not reply to shared note';
  END IF;
END $partner$;
RESET ROLE;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000000e',false);
SET ROLE authenticated;
DO $owner2$
DECLARE room uuid:=current_setting('test.note_room')::uuid;
  private_note uuid:=current_setting('test.note_private_id')::uuid;
  shared_note uuid:=current_setting('test.note_shared_id')::uuid;
BEGIN
  IF public.v2_edit_highlight(room,shared_note,'changed','private',1)<>'replies_locked' THEN
    RAISE EXCEPTION 'private scope may hide partner reply without consent';
  END IF;
  IF public.v2_edit_highlight(room,private_note,'personal revised','private',2)<>'conflict' THEN
    RAISE EXCEPTION 'stale author revision overwrote note';
  END IF;
  IF public.v2_edit_highlight(room,private_note,'personal revised','private',1)<>'saved' THEN
    RAISE EXCEPTION 'owner body edit failed';
  END IF;
  IF public.v2_edit_highlight(room,private_note,'lost update','private',1)<>'conflict' THEN
    RAISE EXCEPTION 'second device revision conflict ignored';
  END IF;
  IF public.v2_edit_highlight(room,private_note,'personal revised','private',2)<>'unchanged' THEN
    RAISE EXCEPTION 'no-op edit should not produce audit event';
  END IF;
  BEGIN
    UPDATE public.reading_highlights_v2 SET body='raw SQL bypass'
      WHERE id=private_note;
    RAISE EXCEPTION 'raw user update was permitted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  IF public.v2_submit_reply(room,private_note,'owner private reply',
    'eeeeeeee-0000-4000-8000-000000000005')<>'saved' THEN
    RAISE EXCEPTION 'private owner reply failed';
  END IF;
  IF public.v2_edit_highlight(room,private_note,'private to shared','shared',2)
    <>'replies_locked' THEN
    RAISE EXCEPTION 'private replies were made public by parent visibility edit';
  END IF;

  IF NOT public.v2_hide_highlight(room,shared_note)
     OR public.v2_hide_highlight(room,shared_note) THEN
    RAISE EXCEPTION 'owner hide not once-only';
  END IF;
  IF public.v2_edit_highlight(room,shared_note,'bad','shared',1)<>'withdrawn' THEN
    RAISE EXCEPTION 'hidden note was edited';
  END IF;
  IF public.v2_submit_highlight(room,0,0,5,'shared initial','shared',
    'eeeeeeee-0000-4000-8000-000000000002')<>'withdrawn' THEN
    RAISE EXCEPTION 'replayed highlight resurrected hidden note';
  END IF;
  IF public.v2_submit_reply(room,shared_note,'after hidden',
    'eeeeeeee-0000-4000-8000-000000000006')<>'denied' THEN
    RAISE EXCEPTION 'SECDEF reply RPC accepted hidden parent';
  END IF;
  IF (SELECT count(*) FROM public.reading_note_replies_v2
    WHERE room_id=room)<>1 THEN
    RAISE EXCEPTION 'reply to hidden shared parent remained queryable';
  END IF;
  IF NOT public.v2_hide_highlight(room,private_note) THEN
    RAISE EXCEPTION 'could not hide private note';
  END IF;
  IF EXISTS(SELECT 1 FROM public.reading_note_replies_v2
    WHERE room_id=room) THEN
    RAISE EXCEPTION 'private child reply remained visible after parent hide';
  END IF;
END $owner2$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false);
SET ROLE authenticated;
DO $partner_after$
DECLARE room uuid:=current_setting('test.note_room')::uuid;
  shared_note uuid:=current_setting('test.note_shared_id')::uuid;
BEGIN
  IF EXISTS(SELECT 1 FROM public.reading_highlights_v2
    WHERE room_id=room) OR EXISTS(SELECT 1 FROM public.reading_note_replies_v2
    WHERE room_id=room) THEN
    RAISE EXCEPTION 'withdrawn shared discussion still visible to partner';
  END IF;
  IF public.v2_submit_reply(room,shared_note,'replay partner discussion',
    'eeeeeeee-0000-4000-8000-000000000004')<>'denied' THEN
    RAISE EXCEPTION 'replay of reply to withdrawn parent was accepted';
  END IF;
END $partner_after$;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000003',false);
DO $outsider$
DECLARE room uuid:=current_setting('test.note_room')::uuid;
BEGIN
  IF public.v2_hide_highlight(room,current_setting('test.note_shared_id')::uuid)
    OR public.v2_edit_highlight(room,current_setting('test.note_shared_id')::uuid,
        'bad','private',1)<>'denied' THEN
    RAISE EXCEPTION 'outsider mutated discussion';
  END IF;
END $outsider$;
RESET ROLE;

DO $audit$
DECLARE event public.reading_audit_v2%ROWTYPE;
  previous text:=repeat('0',64);
  expected text;
  count_events integer:=0;
BEGIN
  FOR event IN SELECT * FROM public.reading_audit_v2
    WHERE room_id=current_setting('test.note_room')::uuid
    ORDER BY sequence_number LOOP
    count_events:=count_events+1;
    IF event.sequence_number<>count_events OR event.previous_hash<>previous THEN
      RAISE EXCEPTION 'note edit/hide audit sequence invalid';
    END IF;
    expected:=encode(sha256(convert_to(jsonb_build_object(
      'version',1,'room',event.room_id,'sequence',event.sequence_number,
      'actor',event.actor_id,'kind',event.action,'note',event.note_id,
      'payload_hash',event.payload_hash,'previous_hash',event.previous_hash,
      'occurred_at',event.occurred_at)::text,'UTF8')),'hex');
    IF expected<>event.event_hash THEN
      RAISE EXCEPTION 'note edit/hide digest mismatch';
    END IF;
    previous:=event.event_hash;
  END LOOP;
  IF count_events<>7 OR
     (SELECT count(*) FROM public.reading_audit_v2
      WHERE room_id=current_setting('test.note_room')::uuid
        AND action='highlight.hidden')<>2 OR
     (SELECT count(*) FROM public.reading_audit_v2
      WHERE room_id=current_setting('test.note_room')::uuid
        AND action='highlight.updated')<>1 THEN
    RAISE EXCEPTION 'unexpected create/edit/hide audit event count %',count_events;
  END IF;
END $audit$;
UPDATE public.reading_rooms_v2 SET state='closed'
WHERE id=current_setting('test.note_room')::uuid;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000000e',false);
SET ROLE authenticated;
DO $closed$
DECLARE room uuid:=current_setting('test.note_room')::uuid;
BEGIN
  IF public.v2_edit_highlight(room,current_setting('test.note_private_id')::uuid,
    'closed','private',4)<>'denied'
     OR public.v2_hide_highlight(room,current_setting('test.note_shared_id')::uuid)
     OR EXISTS(SELECT 1 FROM public.reading_highlights_v2 h WHERE h.room_id=room) THEN
    RAISE EXCEPTION 'closed room allowed note access or mutation';
  END IF;
END $closed$;
RESET ROLE;
SET ROLE anon;
DO $anonymous$
BEGIN
  BEGIN
    PERFORM public.v2_hide_highlight(
      current_setting('test.note_room')::uuid,
      current_setting('test.note_shared_id')::uuid);
    RAISE EXCEPTION 'anonymous highlight mutation allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $anonymous$;
RESET ROLE;
\echo 'PASS: private overlapping note edit/replies, CAS, tombstone, audit and visibility'
