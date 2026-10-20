\set ON_ERROR_STOP on
\ir reading_discovery_v2_smoke.sql
\ir ../../supabase/migrations/20261019180000_v2_room_retention_export_erasure.sql

-- Dedicated active two-seat room for archive, export and destructive actions.
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000011',false);
SET ROLE authenticated;
SELECT public.v2_create_reading_room('Private book and notes') AS retained_room \gset
SELECT set_config('test.retained_room',:'retained_room',false);
SELECT public.v2_create_room_invite(current_setting('test.retained_room')::uuid) AS retained_code \gset
SELECT set_config('test.retained_code',:'retained_code',false);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000012',false);
SET ROLE authenticated;
DO $apply$
BEGIN
 IF public.v2_request_room_join(current_setting('test.retained_code'))<>'submitted'
 THEN RAISE EXCEPTION 'room join prerequisite failed'; END IF;
END $apply$;
RESET ROLE;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000011',false);
SET ROLE authenticated;
DO $approve$
BEGIN
 IF public.v2_review_room_join(current_setting('test.retained_room')::uuid,
  '00000000-0000-4000-8000-000000000012',true) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'room approval prerequisite failed'; END IF;
 IF public.v2_upload_book_chunk(current_setting('test.retained_room')::uuid,
   0,'Shared book begins here') IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'private book upload failed'; END IF;
END $approve$;
INSERT INTO public.reading_highlights_v2
  (room_id,chunk_index,author_id,start_index,end_index,body,visibility)
VALUES(current_setting('test.retained_room')::uuid,0,
 '00000000-0000-4000-8000-000000000011',0,6,
 'Author note to be erased','shared') RETURNING id AS owner_note \gset
SELECT set_config('test.owner_note',:'owner_note',false);
INSERT INTO public.reading_notes_v2
  (room_id,author_id,start_offset,end_offset,body)
VALUES(current_setting('test.retained_room')::uuid,
 '00000000-0000-4000-8000-000000000011',0,2,'Old personal note');
-- Exercise page size without requiring browser, clipboard or unrestricted RPC.
INSERT INTO public.reading_notes_v2
 (room_id,author_id,start_offset,end_offset,body)
SELECT current_setting('test.retained_room')::uuid,
 '00000000-0000-4000-8000-000000000011',0,1,'Page '||n
FROM generate_series(1,50) AS n;
DO $owner_export$
DECLARE r jsonb;
BEGIN
 r:=public.v2_export_my_room_section(current_setting('test.retained_room')::uuid,
   'notes',0);
 IF jsonb_array_length(r->'items')<>50 THEN RAISE EXCEPTION 'export is not bounded'; END IF;
 r:=public.v2_export_my_room_section(current_setting('test.retained_room')::uuid,
   'notes',50);
 IF jsonb_array_length(r->'items')<>1 THEN RAISE EXCEPTION 'next export page lost'; END IF;
 r:=public.v2_export_my_room_section(current_setting('test.retained_room')::uuid,
   'uploads',0);
 IF jsonb_array_length(r->'items')<>1 OR
    r->'items'->0->>'body'<>'Shared book begins here'
 THEN RAISE EXCEPTION 'owner cannot export own uploaded book'; END IF;
END $owner_export$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000012',false);
SET ROLE authenticated;
DO $partner_export$
DECLARE r jsonb;
BEGIN
 r:=public.v2_export_my_room_section(current_setting('test.retained_room')::uuid,
   'uploads',0);
 IF jsonb_array_length(r->'items')<>0 THEN
   RAISE EXCEPTION 'partner downloaded author-only book upload'; END IF;
 r:=public.v2_export_my_room_section(current_setting('test.retained_room')::uuid,
   'notes',0);
 IF jsonb_array_length(r->'items')<>0 THEN
   RAISE EXCEPTION 'partner downloaded private notes'; END IF;
 IF public.v2_export_my_room_section(current_setting('test.retained_room')::uuid,
   'unknown',0) IS NOT NULL OR
    public.v2_export_my_room_section(current_setting('test.retained_room')::uuid,
   'notes',-1) IS NOT NULL THEN
   RAISE EXCEPTION 'bad export arguments accepted'; END IF;
END $partner_export$;
-- Partner replies to owner's shared note; this belongs to the partner even
-- after owner erases the text/hidden parent.
SELECT public.v2_acknowledge_read_chunk(current_setting('test.retained_room')::uuid,0);
SELECT public.v2_submit_reply(current_setting('test.retained_room')::uuid,
 current_setting('test.owner_note')::uuid,'Partner contribution survives',
 '90000000-0000-4000-8000-000000000012') AS partner_reply \gset
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000011',false);
SET ROLE authenticated;
DO $owner_erase$
DECLARE r jsonb;
BEGIN
 r:=public.v2_erase_my_room_content(current_setting('test.retained_room')::uuid);
 IF (r->>'highlights_scrubbed')::integer<>1 OR
    (r->>'notes_deleted')::integer<>51 OR
    EXISTS(SELECT 1 FROM public.reading_notes_v2
      WHERE room_id=current_setting('test.retained_room')::uuid) THEN
   RAISE EXCEPTION 'personal erasure incomplete'; END IF;
END $owner_erase$;
DO $retained_partner$
DECLARE room uuid:=current_setting('test.retained_room')::uuid;
 archived jsonb;
BEGIN
 archived:=public.v2_export_my_room_section(room,'highlights',0);
 IF jsonb_array_length(archived->'items')<>1 OR
   archived->'items'->0->>'body'<>'[内容已删除]' OR
   archived->'items'->0->>'hidden_at' IS NULL OR
   EXISTS(SELECT 1 FROM public.reading_highlights_v2 WHERE room_id=room)
 THEN RAISE EXCEPTION 'erased note remained visible or unsanitized'; END IF;
 IF jsonb_array_length((public.v2_export_my_room_section(room,
     'notes',0))->'items')<>0 THEN
   RAISE EXCEPTION 'deleted private note leaked into export'; END IF;
END $retained_partner$;
-- Archive freezes all reading and cannot be mistaken for leaving/deleting.
DO $archive$
DECLARE room uuid:=current_setting('test.retained_room')::uuid;
BEGIN
 IF NOT public.v2_change_room_state(room,'archived') OR
    public.v2_can_edit_room(room) OR
    NOT public.v2_change_room_state(room,'active') OR
    NOT public.v2_can_edit_room(room) THEN
  RAISE EXCEPTION 'archive restore or freeze failed'; END IF;
END $archive$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000012',false);
SET ROLE authenticated;
DO $leave$
DECLARE room uuid:=current_setting('test.retained_room')::uuid;
BEGIN
 IF public.v2_change_room_state(room,'closed') OR
   NOT public.v2_leave_reading_room(room) OR
   public.v2_leave_reading_room(room) OR
   public.v2_can_edit_room(room) THEN
   RAISE EXCEPTION 'partner leave not isolated'; END IF;
 IF (SELECT count(*) FROM public.v2_my_room_history()
      WHERE room_id=room AND role='partner' AND left_at IS NOT NULL)<>1
 OR jsonb_array_length((public.v2_export_my_room_section(room,'replies',0))
    ->'items')<>1 THEN
   RAISE EXCEPTION 'former reader cannot export own surviving replies'; END IF;
 IF public.v2_purge_closed_room(room)<>'denied' THEN
   RAISE EXCEPTION 'partner could trigger full-room purge'; END IF;
END $leave$;
RESET ROLE;

-- A complete room deletion needs owner closure plus every historical member's
-- explicit consent. Room could not be reopened after close.
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000011',false);
SET ROLE authenticated;
DO $close$
DECLARE room uuid:=current_setting('test.retained_room')::uuid;
BEGIN
 IF NOT public.v2_change_room_state(room,'closed')
   OR public.v2_change_room_state(room,'active')
   OR public.v2_can_edit_room(room)
   OR public.v2_purge_closed_room(room)<>'waiting_for_consent'
   OR public.v2_consent_room_purge(room)<>'consented'
   OR public.v2_purge_closed_room(room)<>'waiting_for_consent' THEN
   RAISE EXCEPTION 'closed room reopened/purged without partner consent'; END IF;
END $close$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000012',false);
SET ROLE authenticated;
DO $former_consent$
BEGIN
 IF public.v2_consent_room_purge(current_setting('test.retained_room')::uuid)
  <>'consented' THEN
   RAISE EXCEPTION 'former partner cannot approve deletion'; END IF;
END $former_consent$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000011',false);
SET ROLE authenticated;
DO $purge$
DECLARE room uuid:=current_setting('test.retained_room')::uuid;
BEGIN
 IF public.v2_purge_closed_room(room)<>'purged' OR
   EXISTS(SELECT 1 FROM public.reading_rooms_v2 WHERE id=room) OR
   EXISTS(SELECT 1 FROM public.reading_members_v2 WHERE room_id=room) OR
   EXISTS(SELECT 1 FROM public.reading_audit_v2 WHERE room_id=room) OR
   public.v2_export_my_room_section(room,'info',0) IS NOT NULL
 THEN RAISE EXCEPTION 'consented room not fully purged'; END IF;
END $purge$;
RESET ROLE;

-- Moderation records block permanent purge; not silently discarded.
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000013',false);
SET ROLE authenticated;
DO $hold$
DECLARE room uuid:=current_setting('test.blocked_room')::uuid;
BEGIN
 IF NOT public.v2_change_room_state(room,'closed')
   OR public.v2_consent_room_purge(room)<>'consented'
   OR public.v2_purge_closed_room(room)<>'moderation_hold' THEN
  RAISE EXCEPTION 'moderation report was silently erased'; END IF;
END $hold$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000014',false);
SET ROLE authenticated;
DO $stranger$
BEGIN
 IF public.v2_export_my_room_section(current_setting('test.blocked_room')::uuid,
    'info',0) IS NOT NULL OR
    public.v2_erase_my_room_content(current_setting('test.blocked_room')::uuid)
     IS NOT NULL OR
    public.v2_consent_room_purge(current_setting('test.blocked_room')::uuid)
      <>'denied' THEN
   RAISE EXCEPTION 'outsider accessed private lifecycle controls'; END IF;
END $stranger$;
RESET ROLE;
SET ROLE anon;
DO $unauth$
BEGIN
 BEGIN
  PERFORM public.v2_my_room_history();
  RAISE EXCEPTION 'anonymous room history RPC executed';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 BEGIN
  PERFORM public.v2_export_my_room_section(
   current_setting('test.blocked_room')::uuid,'info',0);
  RAISE EXCEPTION 'anonymous personal export RPC executed';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 BEGIN
  PERFORM public.v2_purge_closed_room(current_setting('test.blocked_room')::uuid);
  RAISE EXCEPTION 'anonymous purge executed';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $unauth$;
RESET ROLE;
\echo 'PASS: export paging and isolation, own erasure, freeze/reopen, leave, unanimous purge and moderation hold'
