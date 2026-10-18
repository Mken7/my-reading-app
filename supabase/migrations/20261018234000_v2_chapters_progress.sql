-- V2 chapter index and per-user reading cursor. Staging migration only.
-- Do not apply to legacy books, notes, profiles or production Supabase.
-- Requires earlier reading_rooms_v2, reading_members_v2 and reading_chunks_v2.

CREATE TABLE public.reading_chapters_v2 (
  room_id uuid NOT NULL REFERENCES public.reading_rooms_v2(id) ON DELETE CASCADE,
  chapter_position integer NOT NULL CHECK (chapter_position BETWEEN 0 AND 199),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 80),
  start_chunk integer NOT NULL CHECK (start_chunk BETWEEN 0 AND 1999),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, chapter_position),
  FOREIGN KEY (room_id,start_chunk)
    REFERENCES public.reading_chunks_v2(room_id,chunk_index)
);

CREATE TABLE public.reading_progress_v2 (
  room_id uuid NOT NULL REFERENCES public.reading_rooms_v2(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id),
  chunk_index integer NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id,user_id),
  FOREIGN KEY (room_id,chunk_index)
    REFERENCES public.reading_chunks_v2(room_id,chunk_index)
);

ALTER TABLE public.reading_chapters_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reading_progress_v2 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reading_chapters_v2 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON public.reading_progress_v2 FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.reading_chapters_v2 TO authenticated;

-- Only active room members can discover titles; no raw book paragraphs
-- are exposed by this policy. Chapter editing is reserved for trusted RPC.
CREATE POLICY reading_chapters_v2_member_select
ON public.reading_chapters_v2 FOR SELECT TO authenticated
USING (public.v2_can_edit_room(room_id));

CREATE FUNCTION public.v2_publish_chapter(
  target_room uuid, target_position integer, chapter_title text,
  target_start_chunk integer
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor uuid := auth.uid();
  actual_owner uuid;
  actual_state text;
  prior public.reading_chapters_v2%ROWTYPE;
  normalized_title text := pg_catalog.btrim(chapter_title);
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000';
  END IF;
  IF target_position IS NULL OR target_position NOT BETWEEN 0 AND 199
     OR target_start_chunk IS NULL OR target_start_chunk NOT BETWEEN 0 AND 1999
     OR chapter_title IS NULL OR pg_catalog.char_length(normalized_title) NOT BETWEEN 1 AND 80 THEN
    RETURN false;
  END IF;

  SELECT r.owner_id,r.state INTO actual_owner,actual_state
  FROM public.reading_rooms_v2 r WHERE r.id=target_room FOR UPDATE;
  IF actual_owner IS DISTINCT FROM actor OR actual_state IS DISTINCT FROM 'active'
     OR NOT public.v2_is_room_member(target_room) THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.reading_chunks_v2 c
    WHERE c.room_id=target_room AND c.chunk_index=target_start_chunk
  ) THEN
    RETURN false;
  END IF;

  SELECT * INTO prior FROM public.reading_chapters_v2 c
  WHERE c.room_id=target_room AND c.chapter_position=target_position;
  IF FOUND THEN
    RETURN prior.title=normalized_title AND prior.start_chunk=target_start_chunk;
  END IF;
  INSERT INTO public.reading_chapters_v2
    (room_id,chapter_position,title,start_chunk)
  VALUES(target_room,target_position,normalized_title,target_start_chunk);
  RETURN true;
END;
$$;

CREATE FUNCTION public.v2_get_reading_progress(target_room uuid)
RETURNS TABLE(chunk_index integer, revision bigint, updated_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor uuid := auth.uid();
BEGIN
  IF actor IS NULL OR NOT public.v2_can_edit_room(target_room) THEN RETURN; END IF;
  RETURN QUERY
    SELECT p.chunk_index,p.revision,p.updated_at
    FROM public.reading_progress_v2 p
    WHERE p.room_id=target_room AND p.user_id=actor;
END;
$$;

-- Optimistic compare-and-swap prevents an out-of-date device from silently
-- overwriting a newer bookmark. Initial expected revision MUST equal 0.
CREATE FUNCTION public.v2_save_reading_progress(
  target_room uuid, target_chunk integer, expected_revision bigint
)
RETURNS TABLE(saved boolean, chunk_index integer, revision bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor uuid := auth.uid();
  new_chunk integer;
  new_revision bigint;
  current_chunk integer;
  current_revision bigint;
BEGIN
  IF actor IS NULL OR expected_revision IS NULL OR expected_revision < 0
     OR target_chunk IS NULL OR target_chunk NOT BETWEEN 0 AND 1999
     OR NOT public.v2_can_edit_room(target_room) THEN RETURN; END IF;

  IF NOT EXISTS(
    SELECT 1 FROM public.reading_chunks_v2 c
    WHERE c.room_id=target_room AND c.chunk_index=target_chunk
  ) THEN RETURN; END IF;

  INSERT INTO public.reading_progress_v2 (room_id,user_id,chunk_index,revision)
  VALUES (target_room,actor,target_chunk,1)
  ON CONFLICT (room_id,user_id) DO UPDATE
    SET chunk_index=EXCLUDED.chunk_index,
        revision=public.reading_progress_v2.revision+1,
        updated_at=now()
    WHERE public.reading_progress_v2.revision=expected_revision
  RETURNING public.reading_progress_v2.chunk_index,
            public.reading_progress_v2.revision
  INTO new_chunk,new_revision;

  IF FOUND THEN
    RETURN QUERY SELECT true,new_chunk,new_revision;
    RETURN;
  END IF;

  -- The existing revision differs: return only this user's current bookmark.
  SELECT p.chunk_index,p.revision INTO current_chunk,current_revision
  FROM public.reading_progress_v2 p
  WHERE p.room_id=target_room AND p.user_id=actor;
  IF FOUND THEN
    RETURN QUERY SELECT false,current_chunk,current_revision;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.v2_publish_chapter(uuid,integer,text,integer)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.v2_get_reading_progress(uuid)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.v2_save_reading_progress(uuid,integer,bigint)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.v2_publish_chapter(uuid,integer,text,integer)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.v2_get_reading_progress(uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.v2_save_reading_progress(uuid,integer,bigint)
  TO authenticated;
