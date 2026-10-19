-- Module 08: private multi-bookmarks and stricter optimistic cursor sync.
-- Staging V2 only; never apply to the legacy or production Supabase.
CREATE TABLE public.reading_saved_bookmarks_v2 (
  room_id uuid NOT NULL REFERENCES public.reading_rooms_v2(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id),
  chunk_index integer NOT NULL,
  label text NOT NULL DEFAULT '' CHECK (char_length(label) <= 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(room_id,user_id,chunk_index),
  FOREIGN KEY(room_id,chunk_index)
    REFERENCES public.reading_chunks_v2(room_id,chunk_index)
);
ALTER TABLE public.reading_saved_bookmarks_v2 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reading_saved_bookmarks_v2 FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.v2_list_saved_bookmarks(target_room uuid)
RETURNS TABLE(chunk_index integer,label text,created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=''
AS $$
DECLARE actor uuid:=auth.uid();
BEGIN
  IF actor IS NULL OR NOT public.v2_can_edit_room(target_room) THEN RETURN; END IF;
  RETURN QUERY SELECT b.chunk_index,b.label,b.created_at
    FROM public.reading_saved_bookmarks_v2 b
    WHERE b.room_id=target_room AND b.user_id=actor
    ORDER BY b.created_at,b.chunk_index LIMIT 20;
END;
$$;

-- Serialize quota checks across devices. A second press on the same bookmark
-- is idempotent and can update its private (not shared) optional label.
CREATE FUNCTION public.v2_put_saved_bookmark(
  target_room uuid,target_chunk integer,target_label text DEFAULT ''
)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $$
DECLARE actor uuid:=auth.uid(); normalized text:=pg_catalog.btrim(target_label);
BEGIN
  IF actor IS NULL OR target_chunk IS NULL OR
     target_chunk NOT BETWEEN 0 AND 1999 OR
     target_label IS NULL OR pg_catalog.char_length(normalized)>80 OR
     NOT public.v2_can_edit_room(target_room) THEN RETURN false; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_room::text||':'||actor::text,80508));
  IF NOT EXISTS(SELECT 1 FROM public.reading_chunks_v2 c
      WHERE c.room_id=target_room AND c.chunk_index=target_chunk) THEN
    RETURN false;
  END IF;
  IF EXISTS(SELECT 1 FROM public.reading_saved_bookmarks_v2 b
      WHERE b.room_id=target_room AND b.user_id=actor AND b.chunk_index=target_chunk) THEN
    UPDATE public.reading_saved_bookmarks_v2 b SET label=normalized
    WHERE b.room_id=target_room AND b.user_id=actor AND b.chunk_index=target_chunk;
    RETURN true;
  END IF;
  IF (SELECT count(*) FROM public.reading_saved_bookmarks_v2 b
      WHERE b.room_id=target_room AND b.user_id=actor)>=20 THEN RETURN false; END IF;
  INSERT INTO public.reading_saved_bookmarks_v2
    (room_id,user_id,chunk_index,label)
  VALUES (target_room,actor,target_chunk,normalized);
  RETURN true;
END;
$$;

CREATE FUNCTION public.v2_remove_saved_bookmark(
  target_room uuid,target_chunk integer
)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $$
DECLARE actor uuid:=auth.uid();
BEGIN
  IF actor IS NULL OR target_chunk IS NULL OR
     NOT public.v2_can_edit_room(target_room) THEN RETURN false; END IF;
  DELETE FROM public.reading_saved_bookmarks_v2 b
  WHERE b.room_id=target_room AND b.user_id=actor AND b.chunk_index=target_chunk;
  RETURN FOUND;
END;
$$;

-- The previous initial UPSERT could create a cursor when the client sent a
-- NONZERO expected revision but no row existed yet. Require revision 0 to
-- create, then use an UPDATE guarded by the exact server revision.
CREATE OR REPLACE FUNCTION public.v2_save_reading_progress(
  target_room uuid,target_chunk integer,expected_revision bigint
)
RETURNS TABLE(saved boolean,chunk_index integer,revision bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $$
DECLARE
 actor uuid:=auth.uid();
 new_chunk integer;
 new_revision bigint;
 current_chunk integer;
 current_revision bigint;
BEGIN
  IF actor IS NULL OR expected_revision IS NULL OR expected_revision<0
    OR target_chunk IS NULL OR target_chunk NOT BETWEEN 0 AND 1999
    OR NOT public.v2_can_edit_room(target_room) THEN RETURN; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.reading_chunks_v2 c
    WHERE c.room_id=target_room AND c.chunk_index=target_chunk) THEN RETURN; END IF;
  IF expected_revision=0 THEN
    INSERT INTO public.reading_progress_v2(room_id,user_id,chunk_index,revision)
      VALUES(target_room,actor,target_chunk,1)
    ON CONFLICT (room_id,user_id) DO NOTHING
    RETURNING public.reading_progress_v2.chunk_index,
              public.reading_progress_v2.revision INTO new_chunk,new_revision;
  ELSE
    UPDATE public.reading_progress_v2 p
    SET chunk_index=target_chunk,revision=p.revision+1,updated_at=pg_catalog.now()
    WHERE p.room_id=target_room AND p.user_id=actor
      AND p.revision=expected_revision
    RETURNING p.chunk_index,p.revision INTO new_chunk,new_revision;
  END IF;
  IF new_revision IS NOT NULL THEN
    RETURN QUERY SELECT true,new_chunk,new_revision;
    RETURN;
  END IF;
  SELECT p.chunk_index,p.revision INTO current_chunk,current_revision
  FROM public.reading_progress_v2 p
  WHERE p.room_id=target_room AND p.user_id=actor;
  IF FOUND THEN
    RETURN QUERY SELECT false,current_chunk,current_revision;
  END IF;
  -- No row + stale nonzero expected_revision: explicit zero-revision conflict
  -- rather than silently inserting a new cursor.
  RETURN QUERY SELECT false,NULL::integer,0::bigint;
END;
$$;

REVOKE ALL ON FUNCTION public.v2_list_saved_bookmarks(uuid)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.v2_put_saved_bookmark(uuid,integer,text)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.v2_remove_saved_bookmark(uuid,integer)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.v2_list_saved_bookmarks(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.v2_put_saved_bookmark(uuid,integer,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.v2_remove_saved_bookmark(uuid,integer) TO authenticated;
