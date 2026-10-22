-- MODULE 10: content-free real-time change signals and server-enforced spoiler gate.
-- STAGING ONLY: execute after 20261019150000_v2_companion_presence.sql.
-- Authorized readers may request any book chunk, so this prevents ACCIDENTAL
-- future annotation disclosure, not deliberate reading of an accessible book.
CREATE TABLE public.reading_spoiler_frontier_v2 (
  room_id uuid NOT NULL,
  user_id uuid NOT NULL,
  revealed_through integer NOT NULL CHECK (revealed_through BETWEEN 0 AND 1999),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (room_id,user_id),
  FOREIGN KEY (room_id,user_id)
    REFERENCES public.reading_members_v2(room_id,user_id) ON DELETE CASCADE
);
ALTER TABLE public.reading_spoiler_frontier_v2 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reading_spoiler_frontier_v2 FROM PUBLIC,anon,authenticated;

-- ONLY a successful, explicit reader action unlocks annotation context.
-- Clients cannot forge another person's frontier; advancing is monotonic.
CREATE FUNCTION public.v2_acknowledge_read_chunk(target_room uuid,target_chunk integer)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $$
DECLARE actor uuid:=auth.uid();
BEGIN
  IF actor IS NULL OR target_room IS NULL OR target_chunk IS NULL
     OR target_chunk NOT BETWEEN 0 AND 1999
     OR NOT public.v2_can_edit_room(target_room) OR NOT EXISTS(
       SELECT 1 FROM public.reading_chunks_v2 c
       WHERE c.room_id=target_room AND c.chunk_index=target_chunk
     ) THEN RETURN false; END IF;
  INSERT INTO public.reading_spoiler_frontier_v2(room_id,user_id,revealed_through)
  VALUES (target_room,actor,target_chunk)
  ON CONFLICT (room_id,user_id) DO UPDATE
    SET revealed_through=EXCLUDED.revealed_through,updated_at=pg_catalog.now()
    WHERE public.reading_spoiler_frontier_v2.revealed_through<EXCLUDED.revealed_through;
  RETURN true;
END;
$$;

-- Reused by RLS and message triggers. An outsider cannot enumerate future
-- annotations, even with raw PostgREST SELECT or known note/reply/ink UUID.
CREATE FUNCTION public.v2_can_see_shared_chunk(target_room uuid,target_chunk integer)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$
  SELECT target_room IS NOT NULL AND target_chunk IS NOT NULL
    AND public.v2_can_edit_room(target_room)
    AND EXISTS (
      SELECT 1 FROM public.reading_spoiler_frontier_v2 f
      WHERE f.room_id=target_room AND f.user_id=auth.uid()
        AND f.revealed_through>=target_chunk
    );
$$;

-- Reduce pre-existing V2 raw table disclosure, not only React rendering.
DROP POLICY reading_highlights_v2_select ON public.reading_highlights_v2;
CREATE POLICY reading_highlights_v2_select
ON public.reading_highlights_v2 FOR SELECT TO authenticated
USING (
  hidden_at IS NULL AND public.v2_can_edit_room(room_id)
  AND (author_id=auth.uid() OR
       (visibility='shared' AND public.v2_can_see_shared_chunk(room_id,chunk_index)))
);
DROP POLICY reading_ink_v2_visible ON public.reading_ink_v2;
CREATE POLICY reading_ink_v2_visible
ON public.reading_ink_v2 FOR SELECT TO authenticated
USING (
  hidden_at IS NULL AND public.v2_can_edit_room(room_id)
  AND (author_id=auth.uid() OR
       (visibility='shared' AND public.v2_can_see_shared_chunk(room_id,chunk_index)))
);
DROP POLICY reading_note_replies_v2_select ON public.reading_note_replies_v2;
CREATE POLICY reading_note_replies_v2_select
ON public.reading_note_replies_v2 FOR SELECT TO authenticated
USING (
  hidden_at IS NULL AND public.v2_can_edit_room(room_id)
  AND EXISTS (
    SELECT 1 FROM public.reading_highlights_v2 h
    WHERE h.room_id=reading_note_replies_v2.room_id
      AND h.id=reading_note_replies_v2.highlight_id AND h.hidden_at IS NULL
      AND (h.author_id=auth.uid() OR h.visibility='shared')
  )
);
-- Old unanchored reading_notes_v2 has no chunk, so never show another
-- author's unbounded future comment (existing V2 uses reading_highlights_v2).
DROP POLICY reading_notes_v2_read ON public.reading_notes_v2;
CREATE POLICY reading_notes_v2_read
ON public.reading_notes_v2 FOR SELECT TO authenticated
USING (author_id=auth.uid() AND public.v2_can_edit_room(room_id));

-- Reply creation, including SECURITY DEFINER RPC, must honor spoiler frontier.
-- Existing trigger also enforces per-parent reply count and timestamps.
CREATE OR REPLACE FUNCTION public.v2_guard_note_reply()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE total integer;
  parent_chunk integer;
  parent_author uuid;
  parent_visibility text;
BEGIN
  SELECT h.chunk_index,h.author_id,h.visibility
    INTO parent_chunk,parent_author,parent_visibility
  FROM public.reading_highlights_v2 h
  WHERE h.room_id=NEW.room_id AND h.id=NEW.highlight_id
    AND h.hidden_at IS NULL;
  IF parent_chunk IS NULL OR NOT public.v2_can_edit_room(NEW.room_id)
     OR (parent_author IS DISTINCT FROM auth.uid()
         AND (parent_visibility IS DISTINCT FROM 'shared' OR
           NOT public.v2_can_see_shared_chunk(NEW.room_id,parent_chunk))) THEN
    RAISE EXCEPTION 'Reply is not available at this reading position'
      USING ERRCODE='42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(NEW.highlight_id::text, 29810)
  );
  SELECT count(*) INTO total FROM public.reading_note_replies_v2 r
  WHERE r.highlight_id=NEW.highlight_id AND r.room_id=NEW.room_id;
  IF total>=100 THEN RAISE EXCEPTION 'Reply limit reached' USING ERRCODE='23514'; END IF;
  NEW.created_at:=pg_catalog.now();
  RETURN NEW;
END;
$$;

-- Realtime's sole shared-activity payload: room UUID, revision, timestamp.
-- No chunk, title, annotation identifier, location, message or author details.
CREATE TABLE public.reading_shared_signal_v2 (
  room_id uuid PRIMARY KEY REFERENCES public.reading_rooms_v2(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);
ALTER TABLE public.reading_shared_signal_v2 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reading_shared_signal_v2 FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.reading_shared_signal_v2 TO authenticated;
CREATE POLICY reading_shared_signal_v2_active_member
ON public.reading_shared_signal_v2 FOR SELECT TO authenticated
USING (public.v2_can_edit_room(room_id));

CREATE FUNCTION public.v2_signal_shared_activity()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $$
DECLARE source_room uuid;
  send_signal boolean:=false;
BEGIN
  source_room:=NEW.room_id;
  IF TG_TABLE_NAME='reading_highlights_v2' THEN
    send_signal:=(NEW.visibility='shared')
      OR (TG_OP='UPDATE' AND OLD.visibility='shared');
  ELSIF TG_TABLE_NAME='reading_ink_v2' THEN
    send_signal:=(NEW.visibility='shared');
  ELSIF TG_TABLE_NAME='reading_note_replies_v2' THEN
    SELECT h.visibility='shared' INTO send_signal
    FROM public.reading_highlights_v2 h
    WHERE h.room_id=NEW.room_id AND h.id=NEW.highlight_id;
  END IF;
  IF COALESCE(send_signal,false) THEN
    INSERT INTO public.reading_shared_signal_v2(room_id,revision)
    VALUES (source_room,1)
    ON CONFLICT (room_id) DO UPDATE
      SET revision=public.reading_shared_signal_v2.revision+1,
          updated_at=pg_catalog.now();
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reading_highlights_v2_shared_signal
AFTER INSERT OR UPDATE ON public.reading_highlights_v2
FOR EACH ROW EXECUTE FUNCTION public.v2_signal_shared_activity();
CREATE TRIGGER reading_ink_v2_shared_signal
AFTER INSERT OR UPDATE ON public.reading_ink_v2
FOR EACH ROW EXECUTE FUNCTION public.v2_signal_shared_activity();
CREATE TRIGGER reading_note_replies_v2_shared_signal
AFTER INSERT OR UPDATE ON public.reading_note_replies_v2
FOR EACH ROW EXECUTE FUNCTION public.v2_signal_shared_activity();

-- Realtime publication emits only the safe, empty-payload signal table.
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_publication
    WHERE pubname='supabase_realtime' AND NOT puballtables)
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_publication_tables
    WHERE pubname='supabase_realtime' AND schemaname='public'
      AND tablename='reading_shared_signal_v2') THEN
    ALTER PUBLICATION supabase_realtime
      ADD TABLE public.reading_shared_signal_v2;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.v2_acknowledge_read_chunk(uuid,integer)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.v2_can_see_shared_chunk(uuid,integer)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.v2_signal_shared_activity()
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.v2_acknowledge_read_chunk(uuid,integer)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.v2_can_see_shared_chunk(uuid,integer)
  TO authenticated;
