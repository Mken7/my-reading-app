\set ON_ERROR_STOP on
\ir reading_text_anchor_v2_smoke.sql
\ir ../../supabase/migrations/20261019004000_v2_soft_hide.sql

INSERT INTO auth.users(id) VALUES('00000000-0000-4000-8000-000000000009');
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000009',false);
SET ROLE authenticated;
SELECT public.v2_create_reading_room('Hide and audit regression') AS hide_room \gset
SELECT set_config('test.hide_room',:'hide_room',false);

DO $owner$
BEGIN
  IF NOT public.v2_upload_book_chunk(
     current_setting('test.hide_room')::uuid,0,'一个测试书房，隐私不应该被删除破坏') THEN
    RAISE EXCEPTION 'book upload failed';
  END IF;
  INSERT INTO public.reading_highlights_v2(
    room_id,chunk_index,author_id,start_index,end_index,body,visibility)
  VALUES
   (current_setting('test.hide_room')::uuid,0,
    '00000000-0000-4000-8000-000000000009',0,4,'shared note','shared'),
   (current_setting('test.hide_room')::uuid,0,
    '00000000-0000-4000-8000-000000000009',5,7,'private note','private');
  INSERT INTO public.reading_ink_v2(room_id,chunk_index,author_id,
    kind,points,visibility,anchor_start,anchor_end)
  VALUES
   (current_setting('test.hide_room')::uuid,0,
    '00000000-0000-4000-8000-000000000009','ellipse',
    '[{"x":100,"y":100},{"x":500,"y":600}]','shared',0,4),
   (current_setting('test.hide_room')::uuid,0,
    '00000000-0000-4000-8000-000000000009','arrow',
    '[{"x":150,"y":200},{"x":300,"y":300}]','private',5,7);
END $owner$;
RESET ROLE;
SELECT id AS shared_note FROM public.reading_highlights_v2
 WHERE room_id=current_setting('test.hide_room')::uuid AND visibility='shared' \gset
SELECT set_config('test.shared_note',:'shared_note',false);
SELECT id AS shared_ink FROM public.reading_ink_v2
 WHERE room_id=current_setting('test.hide_room')::uuid AND visibility='shared' \gset
SELECT set_config('test.shared_ink',:'shared_ink',false);
SELECT id AS private_ink FROM public.reading_ink_v2
 WHERE room_id=current_setting('test.hide_room')::uuid AND visibility='private' \gset
SELECT set_config('test.private_ink',:'private_ink',false);

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000009',false);
SET ROLE authenticated;
DO $ownerreply$
BEGIN
  INSERT INTO public.reading_note_replies_v2(
    room_id,highlight_id,author_id,body)
  VALUES (current_setting('test.hide_room')::uuid,
    current_setting('test.shared_note')::uuid,
    '00000000-0000-4000-8000-000000000009','owner reply to share');
END $ownerreply$;
RESET ROLE;
SELECT id AS shared_reply FROM public.reading_note_replies_v2
WHERE room_id=current_setting('test.hide_room')::uuid \gset
SELECT set_config('test.shared_reply',:'shared_reply',false);

INSERT INTO public.reading_members_v2(room_id,user_id,role)
VALUES(current_setting('test.hide_room')::uuid,
       '00000000-0000-4000-8000-000000000002','partner');

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false);
SET ROLE authenticated;
DO $partner$
BEGIN
  IF public.v2_hide_ink(
       current_setting('test.hide_room')::uuid,
       current_setting('test.shared_ink')::uuid) THEN
    RAISE EXCEPTION 'partner could hide owner shared ink';
  END IF;
  IF public.v2_hide_reply(
       current_setting('test.hide_room')::uuid,
       current_setting('test.shared_reply')::uuid) THEN
    RAISE EXCEPTION 'partner could hide owner shared reply';
  END IF;

  INSERT INTO public.reading_ink_v2(
    room_id,chunk_index,author_id,kind,points,visibility)
  VALUES(current_setting('test.hide_room')::uuid,0,
    '00000000-0000-4000-8000-000000000002','stroke',
    '[{"x":10,"y":10},{"x":200,"y":200}]','shared');
  INSERT INTO public.reading_note_replies_v2(
    room_id,highlight_id,author_id,body)
  VALUES(current_setting('test.hide_room')::uuid,
    current_setting('test.shared_note')::uuid,
    '00000000-0000-4000-8000-000000000002','partner reply');

  BEGIN
    UPDATE public.reading_ink_v2 SET hidden_at=now()
      WHERE id=current_setting('test.shared_ink')::uuid;
    RAISE EXCEPTION 'client can directly update hidden state';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $partner$;
RESET ROLE;

SELECT id AS partner_ink FROM public.reading_ink_v2
WHERE room_id=current_setting('test.hide_room')::uuid
 AND author_id='00000000-0000-4000-8000-000000000002' \gset
SELECT set_config('test.partner_ink',:'partner_ink',false);
SELECT id AS partner_reply FROM public.reading_note_replies_v2
WHERE room_id=current_setting('test.hide_room')::uuid
 AND author_id='00000000-0000-4000-8000-000000000002' \gset
SELECT set_config('test.partner_reply',:'partner_reply',false);

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000009',false);
SET ROLE authenticated;
DO $ownerhide$
BEGIN
  IF NOT public.v2_hide_ink(
    current_setting('test.hide_room')::uuid,
    current_setting('test.shared_ink')::uuid)
   OR NOT public.v2_hide_reply(
    current_setting('test.hide_room')::uuid,
    current_setting('test.shared_reply')::uuid) THEN
    RAISE EXCEPTION 'owner cannot hide own ink/reply';
  END IF;
  IF public.v2_hide_ink(
    current_setting('test.hide_room')::uuid,
    current_setting('test.shared_ink')::uuid)
   OR public.v2_hide_reply(
    current_setting('test.hide_room')::uuid,
    current_setting('test.shared_reply')::uuid) THEN
    RAISE EXCEPTION 'hiding twice duplicated audit events';
  END IF;
  IF public.v2_hide_ink(
    current_setting('test.hide_room')::uuid,
    current_setting('test.partner_ink')::uuid) THEN
    RAISE EXCEPTION 'owner removed partner ink';
  END IF;
  IF public.v2_hide_reply(
    current_setting('test.hide_room')::uuid,
    current_setting('test.partner_reply')::uuid) THEN
    RAISE EXCEPTION 'owner removed partner reply';
  END IF;
  IF EXISTS(SELECT 1 FROM public.reading_ink_v2
    WHERE id=current_setting('test.shared_ink')::uuid)
   OR EXISTS(SELECT 1 FROM public.reading_note_replies_v2
    WHERE id=current_setting('test.shared_reply')::uuid) THEN
    RAISE EXCEPTION 'hidden items remained visible through RLS';
  END IF;
END $ownerhide$;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false);
DO $partnerhide$
BEGIN
  IF EXISTS(SELECT 1 FROM public.reading_ink_v2
       WHERE id=current_setting('test.shared_ink')::uuid)
     OR EXISTS(SELECT 1 FROM public.reading_note_replies_v2
       WHERE id=current_setting('test.shared_reply')::uuid) THEN
    RAISE EXCEPTION 'partner still sees owner hidden items';
  END IF;
  IF NOT public.v2_hide_ink(current_setting('test.hide_room')::uuid,
        current_setting('test.partner_ink')::uuid)
    OR NOT public.v2_hide_reply(current_setting('test.hide_room')::uuid,
        current_setting('test.partner_reply')::uuid) THEN
    RAISE EXCEPTION 'partner cannot hide own items';
  END IF;
END $partnerhide$;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000003',false);
DO $outsider$
BEGIN
  IF public.v2_hide_ink(current_setting('test.hide_room')::uuid,
       current_setting('test.private_ink')::uuid) OR
     public.v2_hide_reply(current_setting('test.hide_room')::uuid,
       current_setting('test.shared_reply')::uuid) THEN
    RAISE EXCEPTION 'outsider affected hidden state';
  END IF;
END $outsider$;
RESET ROLE;

DO $assert$
DECLARE
  row public.reading_audit_v2%ROWTYPE;
  previous text:=repeat('0',64);
  expected text;
  sequence_count integer:=0;
  hide_count integer:=0;
BEGIN
  IF (SELECT count(*) FROM public.reading_ink_v2
      WHERE room_id=current_setting('test.hide_room')::uuid)<>3
    OR (SELECT count(*) FROM public.reading_note_replies_v2
      WHERE room_id=current_setting('test.hide_room')::uuid)<>2 THEN
    RAISE EXCEPTION 'hide must not physically remove original rows';
  END IF;
  IF (SELECT count(*) FROM public.reading_ink_v2
      WHERE room_id=current_setting('test.hide_room')::uuid
        AND hidden_at IS NOT NULL)<>2 OR
     (SELECT count(*) FROM public.reading_note_replies_v2
      WHERE room_id=current_setting('test.hide_room')::uuid
        AND hidden_at IS NOT NULL)<>2 THEN
    RAISE EXCEPTION 'expected two hidden ink and two hidden replies';
  END IF;
  FOR row IN SELECT * FROM public.reading_audit_v2
    WHERE room_id=current_setting('test.hide_room')::uuid
    ORDER BY sequence_number LOOP
    sequence_count:=sequence_count+1;
    IF row.sequence_number<>sequence_count OR row.previous_hash<>previous THEN
      RAISE EXCEPTION 'hash chain linkage was broken';
    END IF;
    expected:=encode(sha256(convert_to(jsonb_build_object(
      'version',1,'room',row.room_id,'sequence',row.sequence_number,
      'actor',row.actor_id,'kind',row.action,'note',row.note_id,
      'payload_hash',row.payload_hash,'previous_hash',row.previous_hash,
      'occurred_at',row.occurred_at)::text,'UTF8')),'hex');
    IF row.event_hash<>expected THEN
      RAISE EXCEPTION 'event hash changed after hide';
    END IF;
    IF row.action IN ('ink.hidden','reply.hidden') THEN hide_count:=hide_count+1; END IF;
    previous:=row.event_hash;
  END LOOP;
  IF hide_count<>4 OR sequence_count<>11 THEN
    RAISE EXCEPTION 'expected 11 events with 4 hides; got % and %',
      sequence_count,hide_count;
  END IF;
END $assert$;

UPDATE public.reading_rooms_v2 SET state='closed'
WHERE id=current_setting('test.hide_room')::uuid;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000009',false);
SET ROLE authenticated;
DO $closed$
BEGIN
  IF public.v2_hide_ink(current_setting('test.hide_room')::uuid,
    current_setting('test.private_ink')::uuid) THEN
    RAISE EXCEPTION 'closed room permitted hiding';
  END IF;
END $closed$;
RESET ROLE;
SET ROLE anon;
DO $anonymous$
BEGIN
  BEGIN
    PERFORM public.v2_hide_ink(current_setting('test.hide_room')::uuid,
      current_setting('test.private_ink')::uuid);
    RAISE EXCEPTION 'anonymous user reached hide RPC';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $anonymous$;
RESET ROLE;
\echo 'PASS: audited owner-only hide, private visibility and non-destructive originals'
