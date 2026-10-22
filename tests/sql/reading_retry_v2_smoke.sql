\set ON_ERROR_STOP on
\ir reading_hide_v2_smoke.sql
\ir ../../supabase/migrations/20261019005000_v2_idempotent_submissions.sql

INSERT INTO auth.users(id) VALUES('00000000-0000-4000-8000-00000000000a');
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000000a',false);
SET ROLE authenticated;
SELECT public.v2_create_reading_room('Retryable notes test') AS retry_room \gset
SELECT set_config('test.retry_room',:'retry_room',false);
DO $owner$
DECLARE
  room uuid:=current_setting('test.retry_room')::uuid;
  op uuid:='aaaaaaaa-0000-4000-8000-000000000001';
BEGIN
  IF NOT public.v2_upload_book_chunk(room,0,'用于双人文字批注重试的测试段落') THEN
    RAISE EXCEPTION 'chunk upload failed';
  END IF;
  IF public.v2_submit_highlight(room,0,0,3,'shared note','shared',op)<>'saved'
     OR public.v2_submit_highlight(room,0,0,3,'shared note','shared',op)<>'already_saved' THEN
    RAISE EXCEPTION 'retry of an acknowledged highlight must be idempotent';
  END IF;
  IF public.v2_submit_highlight(room,0,0,3,'shared note','private',op)<>'conflict'
     OR public.v2_submit_highlight(room,0,0,3,'edited text','shared',op)<>'conflict'
     OR public.v2_submit_highlight(room,0,1,3,'shared note','shared',op)<>'conflict' THEN
    RAISE EXCEPTION 'same operation altered text, span or visibility';
  END IF;
  BEGIN
    PERFORM public.v2_submit_highlight(room,0,0,100,'bad span','shared',
      'aaaaaaaa-0000-4000-8000-000000000003');
    RAISE EXCEPTION 'invalid text span accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $owner$;
RESET ROLE;
SELECT id AS shared_note_id FROM public.reading_highlights_v2
WHERE room_id=current_setting('test.retry_room')::uuid
  AND client_operation_id='aaaaaaaa-0000-4000-8000-000000000001' \gset
SELECT set_config('test.shared_note_id',:'shared_note_id',false);

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000000a',false);
SET ROLE authenticated;
DO $owner2$
DECLARE
  room uuid:=current_setting('test.retry_room')::uuid;
  shared uuid:=current_setting('test.shared_note_id')::uuid;
  op uuid:='aaaaaaaa-0000-4000-8000-000000000002';
BEGIN
  IF public.v2_submit_highlight(room,0,4,6,'private note','private',op)<>'saved'
     OR public.v2_submit_highlight(room,0,4,6,'private note','private',op)<>'already_saved' THEN
    RAISE EXCEPTION 'private note was duplicated';
  END IF;
  IF public.v2_submit_reply(room,shared,'owner reply',
      'bbbbbbbb-0000-4000-8000-000000000001')<>'saved'
     OR public.v2_submit_reply(room,shared,'owner reply',
      'bbbbbbbb-0000-4000-8000-000000000001')<>'already_saved' THEN
    RAISE EXCEPTION 'owner reply replay duplicated';
  END IF;
  IF public.v2_submit_reply(room,shared,'changed reply',
    'bbbbbbbb-0000-4000-8000-000000000001')<>'conflict' THEN
    RAISE EXCEPTION 'same reply operation changed content';
  END IF;
  BEGIN
    UPDATE public.reading_highlights_v2
    SET client_operation_id='ffffffff-0000-4000-8000-000000000001'
    WHERE client_operation_id='aaaaaaaa-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'client changed immutable operation ID';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $owner2$;
RESET ROLE;
SELECT id AS private_note_id FROM public.reading_highlights_v2
WHERE room_id=current_setting('test.retry_room')::uuid
  AND client_operation_id='aaaaaaaa-0000-4000-8000-000000000002' \gset
SELECT set_config('test.private_note_id',:'private_note_id',false);
SELECT id AS owner_reply_id FROM public.reading_note_replies_v2
WHERE room_id=current_setting('test.retry_room')::uuid
  AND client_operation_id='bbbbbbbb-0000-4000-8000-000000000001' \gset
SELECT set_config('test.owner_reply_id',:'owner_reply_id',false);

INSERT INTO public.reading_members_v2(room_id,user_id,role)
VALUES (current_setting('test.retry_room')::uuid,
  '00000000-0000-4000-8000-000000000002','partner');

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false);
SET ROLE authenticated;
DO $partner$
DECLARE
  room uuid:=current_setting('test.retry_room')::uuid;
  shared uuid:=current_setting('test.shared_note_id')::uuid;
  private_id uuid:=current_setting('test.private_note_id')::uuid;
BEGIN
  IF public.v2_submit_reply(room,private_id,'private leak',
      'bbbbbbbb-0000-4000-8000-000000000002')<>'denied' THEN
    RAISE EXCEPTION 'partner replied to private note';
  END IF;
  IF public.v2_submit_reply(room,shared,'partner reply',
      'bbbbbbbb-0000-4000-8000-000000000002')<>'saved'
     OR public.v2_submit_reply(room,shared,'partner reply',
      'bbbbbbbb-0000-4000-8000-000000000002')<>'already_saved' THEN
    RAISE EXCEPTION 'partner reply replay failed';
  END IF;
  IF (SELECT count(*) FROM public.reading_note_replies_v2
      WHERE room_id=room)<>2 THEN
    RAISE EXCEPTION 'unexpected duplicate or private reply leak';
  END IF;
  IF public.v2_submit_highlight(room,0,1,2,'partner note','shared',
    'aaaaaaaa-0000-4000-8000-000000000001')<>'saved' THEN
    RAISE EXCEPTION 'client op UUID must be unique only per author, not per partner';
  END IF;
END $partner$;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000003',false);
DO $outsider$
BEGIN
  IF public.v2_submit_highlight(
    current_setting('test.retry_room')::uuid,0,0,1,'outsider','shared',
    'cccccccc-0000-4000-8000-000000000001')<>'denied'
    OR public.v2_submit_reply(
    current_setting('test.retry_room')::uuid,
    current_setting('test.shared_note_id')::uuid,'outsider',
    'cccccccc-0000-4000-8000-000000000002')<>'denied' THEN
    RAISE EXCEPTION 'outsider reached idempotent submission';
  END IF;
END $outsider$;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000000a',false);
DO $withdrawn$
DECLARE
  room uuid:=current_setting('test.retry_room')::uuid;
  note uuid:=current_setting('test.shared_note_id')::uuid;
BEGIN
  IF NOT public.v2_hide_reply(room,current_setting('test.owner_reply_id')::uuid) THEN
    RAISE EXCEPTION 'owner failed to hide original reply';
  END IF;
  IF public.v2_submit_reply(room,note,'owner reply',
    'bbbbbbbb-0000-4000-8000-000000000001')<>'withdrawn' THEN
    RAISE EXCEPTION 'replay resurrected a hidden reply';
  END IF;
END $withdrawn$;
RESET ROLE;

DO $audit$
DECLARE
  event public.reading_audit_v2%ROWTYPE;
  previous text:=repeat('0',64);
  expected text;
  count_events integer:=0;
BEGIN
  FOR event IN SELECT * FROM public.reading_audit_v2
    WHERE room_id=current_setting('test.retry_room')::uuid
    ORDER BY sequence_number LOOP
    count_events:=count_events+1;
    IF event.sequence_number<>count_events OR event.previous_hash<>previous THEN
      RAISE EXCEPTION 'idempotent audit chain broken';
    END IF;
    expected:=encode(sha256(convert_to(jsonb_build_object(
      'version',1,'room',event.room_id,'sequence',event.sequence_number,
      'actor',event.actor_id,'kind',event.action,'note',event.note_id,
      'payload_hash',event.payload_hash,'previous_hash',event.previous_hash,
      'occurred_at',event.occurred_at)::text,'UTF8')),'hex');
    IF event.event_hash<>expected THEN
      RAISE EXCEPTION 'idempotent event digest mismatch';
    END IF;
    previous:=event.event_hash;
  END LOOP;
  -- Two owner notes + one partner note + two replies + one hide = six.
  IF count_events<>6 OR
     (SELECT count(*) FROM public.reading_highlights_v2
      WHERE room_id=current_setting('test.retry_room')::uuid)<>3 OR
     (SELECT count(*) FROM public.reading_note_replies_v2
      WHERE room_id=current_setting('test.retry_room')::uuid)<>2 THEN
    RAISE EXCEPTION 'retry caused duplicate note, reply or audit events';
  END IF;
END $audit$;

UPDATE public.reading_rooms_v2 SET state='closed'
WHERE id=current_setting('test.retry_room')::uuid;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000000a',false);
SET ROLE authenticated;
DO $closed$
BEGIN
  IF public.v2_submit_highlight(
    current_setting('test.retry_room')::uuid,0,0,3,'shared note','shared',
    'aaaaaaaa-0000-4000-8000-000000000001')<>'denied' THEN
    RAISE EXCEPTION 'closed room accepted saved-note replay';
  END IF;
END $closed$;
RESET ROLE;
SET ROLE anon;
DO $anonymous$
BEGIN
  BEGIN
    PERFORM public.v2_submit_reply(
      current_setting('test.retry_room')::uuid,
      current_setting('test.shared_note_id')::uuid,
      'test','eeeeeeee-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'anonymous submit RPC exposed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $anonymous$;
RESET ROLE;
\echo 'PASS: idempotent submissions, private visibility, unchanged payload, lost ACK retry and audit chain'
