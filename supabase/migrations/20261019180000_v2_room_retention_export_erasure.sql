-- Module 12. V2 staging only, after 20261019170000_v2_room_discovery_moderation.sql.
-- A user's own material is exportable after leaving/closing. Room destruction
-- requires consent from every historical member and no retained moderation case.
-- No anonymous or authenticated direct table mutation is permitted.

CREATE TABLE public.reading_room_purge_consents_v2(
 room_id uuid NOT NULL,
 user_id uuid NOT NULL,
 consented_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
 PRIMARY KEY(room_id,user_id),
 FOREIGN KEY(room_id,user_id)
   REFERENCES public.reading_members_v2(room_id,user_id) ON DELETE CASCADE
);
ALTER TABLE public.reading_room_purge_consents_v2 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reading_room_purge_consents_v2 FROM PUBLIC,anon,authenticated;

-- A partner leaves immediately without deleting the other reader's work.
-- Historic membership persists for private personal export and purge consent.
CREATE FUNCTION public.v2_leave_reading_room(target_room uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $$
DECLARE actor uuid:=auth.uid(); owner uuid; state text; affected integer;
BEGIN
 IF actor IS NULL OR target_room IS NULL THEN RETURN false; END IF;
 SELECT r.owner_id,r.state INTO owner,state FROM public.reading_rooms_v2 r
 WHERE r.id=target_room FOR UPDATE;
 IF owner IS NULL OR owner=actor OR state IS DISTINCT FROM 'active' THEN
  RETURN false; END IF;
 UPDATE public.reading_members_v2 m SET left_at=pg_catalog.now()
 WHERE m.room_id=target_room AND m.user_id=actor AND m.role='partner'
 AND m.left_at IS NULL;
 GET DIAGNOSTICS affected=ROW_COUNT;
 -- revoke outstanding join requests without erasing saved reader history.
 IF affected=1 THEN
  UPDATE public.reading_discovery_requests_v2 q
   SET status='withdrawn',reviewed_at=pg_catalog.now()
   WHERE q.room_id=target_room AND q.requester_id=actor AND q.status='pending';
 END IF;
 RETURN affected=1;
END $$;

-- A room's archive is frozen (all active-reading RLS gates already require
-- state='active'); the owner may reopen an archive, but never a closed room.
CREATE FUNCTION public.v2_change_room_state(target_room uuid,target_state text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $$
DECLARE actor uuid:=auth.uid(); owner uuid; old_state text;
BEGIN
 IF actor IS NULL OR target_room IS NULL
   OR target_state NOT IN ('active','archived','closed') THEN RETURN false; END IF;
 SELECT r.owner_id,r.state INTO owner,old_state FROM public.reading_rooms_v2 r
 WHERE r.id=target_room FOR UPDATE;
 IF owner IS DISTINCT FROM actor OR
   NOT EXISTS(SELECT 1 FROM public.reading_members_v2 m
    WHERE m.room_id=target_room AND m.user_id=actor AND m.left_at IS NULL)
 THEN RETURN false; END IF;
 IF old_state=target_state THEN RETURN true; END IF;
 IF NOT (
    (old_state='active' AND target_state IN ('archived','closed'))
    OR (old_state='archived' AND target_state IN ('active','closed'))
 ) THEN RETURN false; END IF;
 UPDATE public.reading_rooms_v2 SET state=target_state WHERE id=target_room;
 -- Discovery, invites and pending requests cannot survive closure/freeze.
 IF target_state<>'active' THEN
  UPDATE public.reading_directory_v2
    SET listed=false,updated_at=pg_catalog.now() WHERE room_id=target_room;
  UPDATE public.reading_invitations_v2 SET status='revoked'
    WHERE room_id=target_room AND status='open';
  UPDATE public.reading_join_requests_v2
    SET status='rejected',reviewed_at=pg_catalog.now()
    WHERE room_id=target_room AND status='pending';
  UPDATE public.reading_discovery_requests_v2
    SET status='rejected',reviewed_at=pg_catalog.now()
    WHERE room_id=target_room AND status='pending';
 END IF;
 RETURN true;
END $$;

-- Never use raw SELECT on retired users' private content; this function
-- intentionally exports only the actor's own authored/recorded data.
-- One page is capped at 50 entries so a large imported book does not cause an
-- unbounded RPC response. The response contains zero external account emails.
CREATE FUNCTION public.v2_export_my_room_section(
 target_room uuid,target_section text,page_offset integer DEFAULT 0
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=''
AS $$
DECLARE actor uuid:=auth.uid(); results jsonb:='[]'::jsonb; meta jsonb;
BEGIN
 IF actor IS NULL OR target_room IS NULL OR target_section IS NULL OR
    target_section NOT IN ('info','notes','highlights','replies','ink',
     'bookmarks','progress','uploads') OR page_offset IS NULL OR
    page_offset<0 OR page_offset>20000 OR
    NOT EXISTS(SELECT 1 FROM public.reading_members_v2 m
      WHERE m.room_id=target_room AND m.user_id=actor)
 THEN RETURN NULL; END IF;
 IF target_section='info' THEN
   SELECT pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
     'room_id',r.id,'book_title',r.title,'room_state',r.state,
     'my_role',m.role,'joined_at',m.joined_at,'left_at',m.left_at,
     'export_format','v2-personal-1'))
   INTO results FROM public.reading_rooms_v2 r
   JOIN public.reading_members_v2 m ON m.room_id=r.id
   WHERE r.id=target_room AND m.user_id=actor;
 ELSIF target_section='notes' THEN
   SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(q)),'[]'::jsonb)
   INTO results FROM (SELECT n.id,n.start_offset,n.end_offset,n.body,
     n.visibility,n.revision,n.created_at FROM public.reading_notes_v2 n
     WHERE n.room_id=target_room AND n.author_id=actor
     ORDER BY n.id LIMIT 50 OFFSET page_offset) q;
 ELSIF target_section='highlights' THEN
   SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(q)),'[]'::jsonb)
   INTO results FROM (SELECT h.id,h.chunk_index,h.start_index,h.end_index,
     h.body,h.visibility,h.revision,h.hidden_at,h.created_at
     FROM public.reading_highlights_v2 h
     WHERE h.room_id=target_room AND h.author_id=actor
     ORDER BY h.id LIMIT 50 OFFSET page_offset) q;
 ELSIF target_section='replies' THEN
   SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(q)),'[]'::jsonb)
   INTO results FROM (SELECT n.id,n.highlight_id,n.body,n.hidden_at,
     n.created_at FROM public.reading_note_replies_v2 n
     WHERE n.room_id=target_room AND n.author_id=actor
     ORDER BY n.id LIMIT 50 OFFSET page_offset) q;
 ELSIF target_section='ink' THEN
   SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(q)),'[]'::jsonb)
   INTO results FROM (SELECT i.id,i.chunk_index,i.kind,i.points,i.visibility,
     i.anchor_start,i.anchor_end,i.anchor_layout,i.hidden_at,i.created_at
     FROM public.reading_ink_v2 i WHERE i.room_id=target_room AND i.author_id=actor
     ORDER BY i.id LIMIT 50 OFFSET page_offset) q;
 ELSIF target_section='bookmarks' THEN
   SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(q)),'[]'::jsonb)
   INTO results FROM (SELECT b.chunk_index,b.label,b.created_at
     FROM public.reading_saved_bookmarks_v2 b
     WHERE b.room_id=target_room AND b.user_id=actor
     ORDER BY b.chunk_index LIMIT 50 OFFSET page_offset) q;
 ELSIF target_section='progress' THEN
   SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(q)),'[]'::jsonb)
   INTO results FROM (SELECT p.chunk_index,p.char_offset,p.revision,p.updated_at
     FROM public.reading_progress_v2 p
     WHERE p.room_id=target_room AND p.user_id=actor
     LIMIT 50 OFFSET page_offset) q;
 ELSIF target_section='uploads' THEN
   SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(q)),'[]'::jsonb)
   INTO results FROM (SELECT c.chunk_index,c.body,c.created_at
     FROM public.reading_chunks_v2 c
     WHERE c.room_id=target_room AND c.uploaded_by=actor
     ORDER BY c.chunk_index LIMIT 50 OFFSET page_offset) q;
 END IF;
 RETURN pg_catalog.jsonb_build_object('section',target_section,'room_id',
    target_room,'offset',page_offset,'items',coalesce(results,'[]'::jsonb));
END $$;

CREATE FUNCTION public.v2_my_room_history()
RETURNS TABLE(room_id uuid,book_title text,role text,room_state text,
 left_at timestamptz,my_purge_consent boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$
 SELECT r.id,r.title,m.role,r.state,m.left_at,
   EXISTS(SELECT 1 FROM public.reading_room_purge_consents_v2 c
      WHERE c.room_id=r.id AND c.user_id=auth.uid())
 FROM public.reading_members_v2 m JOIN public.reading_rooms_v2 r ON r.id=m.room_id
 WHERE auth.uid() IS NOT NULL AND m.user_id=auth.uid()
 ORDER BY r.created_at DESC LIMIT 100;
$$;

-- Personal content erasure is an irreversible decision, independently available
-- after leaving or room closure, but is NOT account/auth/audit deletion.
-- Preserve another user's replies to the erased author's thread as a hidden
-- parent-referenced record. Its parent body is scrubbed in-place.
CREATE FUNCTION public.v2_erase_my_room_content(target_room uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $$
DECLARE actor uuid:=auth.uid(); reply_count integer;ink_count integer;
 highlight_count integer; note_count integer; bookmarks_count integer;
 progress_count integer;
BEGIN
 IF actor IS NULL OR target_room IS NULL OR NOT EXISTS(
   SELECT 1 FROM public.reading_members_v2 m
   WHERE m.room_id=target_room AND m.user_id=actor
 ) THEN RETURN NULL; END IF;
 PERFORM 1 FROM public.reading_rooms_v2 WHERE id=target_room FOR UPDATE;
 -- Delete author replies first; partner replies remain FK-referenced to a
 -- permanently hidden, scrubbed marker (and remain privately exportable).
 DELETE FROM public.reading_note_replies_v2
  WHERE room_id=target_room AND author_id=actor;
 GET DIAGNOSTICS reply_count=ROW_COUNT;
 DELETE FROM public.reading_ink_v2
  WHERE room_id=target_room AND author_id=actor;
 GET DIAGNOSTICS ink_count=ROW_COUNT;
 UPDATE public.reading_highlights_v2 h SET
  body='[内容已删除]',hidden_at=coalesce(h.hidden_at,pg_catalog.now()),
  hidden_by=actor
 WHERE h.room_id=target_room AND h.author_id=actor
   AND (h.body<>'[内容已删除]' OR h.hidden_at IS NULL);
 GET DIAGNOSTICS highlight_count=ROW_COUNT;
 DELETE FROM public.reading_notes_v2
  WHERE room_id=target_room AND author_id=actor;
 GET DIAGNOSTICS note_count=ROW_COUNT;
 DELETE FROM public.reading_saved_bookmarks_v2
  WHERE room_id=target_room AND user_id=actor;
 GET DIAGNOSTICS bookmarks_count=ROW_COUNT;
 DELETE FROM public.reading_progress_v2
  WHERE room_id=target_room AND user_id=actor;
 GET DIAGNOSTICS progress_count=ROW_COUNT;
 DELETE FROM public.reading_spoiler_frontier_v2
  WHERE room_id=target_room AND user_id=actor;
 DELETE FROM public.reading_presence_v2
  WHERE room_id=target_room AND user_id=actor;
 DELETE FROM public.reading_read_quota_v2
  WHERE room_id=target_room AND user_id=actor;
 -- No uploaded book chunks, other authors' replies, past audit digests,
 -- historic membership, moderation reports or Auth identity are deleted.
 RETURN pg_catalog.jsonb_build_object('replies_deleted',reply_count,
  'ink_deleted',ink_count,'highlights_scrubbed',highlight_count,
  'notes_deleted',note_count,'bookmarks_deleted',bookmarks_count,
  'progress_deleted',progress_count,'historic_metadata_retained',true);
END $$;

-- A closed room's owner and EVERY historic participant must explicitly
-- consent to deletion of shared book/pages/other members' contributions.
-- Consent is retained only until room deletion. Closed rooms cannot reopen.
CREATE FUNCTION public.v2_consent_room_purge(target_room uuid)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $$
DECLARE actor uuid:=auth.uid(); room_state text;
BEGIN
 IF actor IS NULL OR target_room IS NULL THEN RETURN 'denied'; END IF;
 SELECT r.state INTO room_state FROM public.reading_rooms_v2 r
 WHERE id=target_room FOR UPDATE;
 IF room_state IS DISTINCT FROM 'closed' OR NOT EXISTS(
  SELECT 1 FROM public.reading_members_v2 m
  WHERE m.room_id=target_room AND m.user_id=actor
 ) THEN RETURN 'denied'; END IF;
 INSERT INTO public.reading_room_purge_consents_v2(room_id,user_id)
 VALUES(target_room,actor) ON CONFLICT DO NOTHING;
 RETURN 'consented';
END $$;

CREATE FUNCTION public.v2_purge_closed_room(target_room uuid)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $$
DECLARE actor uuid:=auth.uid(); owner uuid; room_state text;
BEGIN
 IF actor IS NULL OR target_room IS NULL THEN RETURN 'denied'; END IF;
 SELECT r.owner_id,r.state INTO owner,room_state FROM public.reading_rooms_v2 r
 WHERE r.id=target_room FOR UPDATE;
 IF owner IS DISTINCT FROM actor OR room_state IS DISTINCT FROM 'closed'
   THEN RETURN 'denied'; END IF;
 IF EXISTS (
  SELECT 1 FROM public.reading_members_v2 m
  WHERE m.room_id=target_room AND NOT EXISTS (
   SELECT 1 FROM public.reading_room_purge_consents_v2 c
   WHERE c.room_id=m.room_id AND c.user_id=m.user_id
  )
 ) THEN RETURN 'waiting_for_consent'; END IF;
 IF EXISTS(
  SELECT 1 FROM public.reading_discovery_reports_v2 z
  WHERE z.room_id=target_room
 ) THEN RETURN 'moderation_hold'; END IF;
 -- No report or audit can silently survive as a dangling room reference.
 DELETE FROM public.reading_note_replies_v2 WHERE room_id=target_room;
 DELETE FROM public.reading_ink_v2 WHERE room_id=target_room;
 DELETE FROM public.reading_highlights_v2 WHERE room_id=target_room;
 DELETE FROM public.reading_saved_bookmarks_v2 WHERE room_id=target_room;
 DELETE FROM public.reading_progress_v2 WHERE room_id=target_room;
 DELETE FROM public.reading_chapters_v2 WHERE room_id=target_room;
 DELETE FROM public.reading_chunks_v2 WHERE room_id=target_room;
 DELETE FROM public.reading_notes_v2 WHERE room_id=target_room;
 DELETE FROM public.reading_audit_v2 WHERE room_id=target_room;
 DELETE FROM public.reading_rooms_v2 WHERE id=target_room;
 RETURN 'purged';
END $$;

DO $$
DECLARE sig text;
BEGIN
 FOREACH sig IN ARRAY ARRAY[
  'v2_leave_reading_room(uuid)','v2_change_room_state(uuid,text)',
  'v2_export_my_room_section(uuid,text,integer)',
  'v2_my_room_history()','v2_erase_my_room_content(uuid)',
  'v2_consent_room_purge(uuid)','v2_purge_closed_room(uuid)'
 ] LOOP
 EXECUTE 'REVOKE ALL ON FUNCTION public.'||sig||
   ' FROM PUBLIC,anon,authenticated';
 EXECUTE 'GRANT EXECUTE ON FUNCTION public.'||sig||' TO authenticated';
 END LOOP;
END $$;
