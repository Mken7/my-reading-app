-- V2 private book content delivery - staging-only migration.
-- DOES NOT touch existing public.books or production book content.
-- Requires earlier V2 rooms/members migrations. Authn/RLS is server-side.
-- Hiding JS or disabling text selection is NOT a security boundary.

CREATE TABLE public.reading_chunks_v2 (
  room_id uuid NOT NULL REFERENCES public.reading_rooms_v2(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL CHECK (chunk_index BETWEEN 0 AND 1999),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 3000),
  uploaded_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, chunk_index)
);

CREATE TABLE public.reading_read_quota_v2 (
  room_id uuid NOT NULL REFERENCES public.reading_rooms_v2(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id),
  window_start timestamptz NOT NULL DEFAULT now(),
  chunks_read integer NOT NULL DEFAULT 0 CHECK (chunks_read BETWEEN 0 AND 60),
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE public.reading_upload_quota_v2 (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id),
  window_start timestamptz NOT NULL DEFAULT now(),
  chunks_uploaded integer NOT NULL DEFAULT 0 CHECK (chunks_uploaded BETWEEN 0 AND 300)
);

ALTER TABLE public.reading_chunks_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reading_read_quota_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reading_upload_quota_v2 ENABLE ROW LEVEL SECURITY;

-- No authenticated or anonymous client can read the raw chunk table
-- or modify the counters, even when it knows room UUIDs.
REVOKE ALL ON public.reading_chunks_v2 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON public.reading_read_quota_v2 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON public.reading_upload_quota_v2 FROM PUBLIC,anon,authenticated;

-- Each room owner inserts immutable chunks (no UPDATE/DELETE RPC). Separate
-- book replacement/versioning must be designed before any public launch.
CREATE FUNCTION public.v2_upload_book_chunk(
  target_room uuid, target_index integer, chunk_text text
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor uuid := auth.uid();
  room_owner uuid;
  room_state text;
  uploaded integer;
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000';
  END IF;
  IF target_index IS NULL OR target_index NOT BETWEEN 0 AND 1999
     OR chunk_text IS NULL OR char_length(chunk_text) NOT BETWEEN 1 AND 3000 THEN
    RETURN false;
  END IF;

  -- Lock one room while checking ownership, assigning index and charging
  -- the quota. Concurrent uploads cannot bypass per-user limits.
  SELECT r.owner_id,r.state INTO room_owner,room_state
  FROM public.reading_rooms_v2 r
  WHERE r.id=target_room FOR UPDATE;
  IF room_owner IS DISTINCT FROM actor OR room_state IS DISTINCT FROM 'active'
     OR NOT public.v2_is_room_member(target_room) THEN
    RETURN false;
  END IF;

  -- Idempotent retry does not consume capacity, cannot replace contents.
  IF EXISTS(SELECT 1 FROM public.reading_chunks_v2 c
            WHERE c.room_id=target_room AND c.chunk_index=target_index) THEN
    RETURN false;
  END IF;

  INSERT INTO public.reading_upload_quota_v2
    (user_id,window_start,chunks_uploaded) VALUES (actor,now(),1)
  ON CONFLICT(user_id) DO UPDATE SET
    window_start = CASE
      WHEN public.reading_upload_quota_v2.window_start <= now()-interval '24 hours'
      THEN now() ELSE public.reading_upload_quota_v2.window_start END,
    chunks_uploaded = CASE
      WHEN public.reading_upload_quota_v2.window_start <= now()-interval '24 hours'
      THEN 1 ELSE least(public.reading_upload_quota_v2.chunks_uploaded+1,300) END
  WHERE public.reading_upload_quota_v2.window_start <= now()-interval '24 hours'
     OR public.reading_upload_quota_v2.chunks_uploaded < 300
  RETURNING chunks_uploaded INTO uploaded;

  IF uploaded IS NULL THEN RETURN false; END IF;

  INSERT INTO public.reading_chunks_v2
    (room_id,chunk_index,body,uploaded_by)
  VALUES(target_room,target_index,chunk_text,actor);
  RETURN true;
END;
$$;

-- Return at most two 3k-char chunks in a single explicit request.
-- The data is never available via direct table SELECT.
-- Limit one user to 60 actual chunks per room in a rolling 1-hour window.
CREATE FUNCTION public.v2_read_book_chunks(
  target_room uuid, from_index integer, requested_count integer DEFAULT 1
)
RETURNS TABLE(chunk_index integer, body text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor uuid := auth.uid();
  number_found integer;
  old_total integer;
  room_state text;
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000';
  END IF;
  IF from_index IS NULL OR from_index NOT BETWEEN 0 AND 1999
     OR requested_count IS NULL OR requested_count NOT BETWEEN 1 AND 2
     OR from_index + requested_count > 2000 THEN
    RETURN;
  END IF;

  SELECT r.state INTO room_state
  FROM public.reading_rooms_v2 r
  WHERE r.id=target_room;
  IF room_state IS DISTINCT FROM 'active'
     OR NOT public.v2_is_room_member(target_room) THEN
    RETURN;
  END IF;

  SELECT count(*)::integer INTO number_found
  FROM public.reading_chunks_v2 c
  WHERE c.room_id=target_room AND c.chunk_index>=from_index
    AND c.chunk_index<from_index+requested_count;
  IF number_found=0 THEN RETURN; END IF;

  INSERT INTO public.reading_read_quota_v2
    (room_id,user_id,window_start,chunks_read)
  VALUES(target_room,actor,now(),number_found)
  ON CONFLICT(room_id,user_id) DO UPDATE SET
    window_start = CASE
      WHEN public.reading_read_quota_v2.window_start <= now()-interval '1 hour'
      THEN now() ELSE public.reading_read_quota_v2.window_start END,
    chunks_read = CASE
      WHEN public.reading_read_quota_v2.window_start <= now()-interval '1 hour'
      THEN EXCLUDED.chunks_read
      ELSE public.reading_read_quota_v2.chunks_read+EXCLUDED.chunks_read END
  WHERE public.reading_read_quota_v2.window_start <= now()-interval '1 hour'
     OR public.reading_read_quota_v2.chunks_read+EXCLUDED.chunks_read<=60
  RETURNING chunks_read INTO old_total;

  IF old_total IS NULL THEN RETURN; END IF;

  RETURN QUERY SELECT c.chunk_index,c.body
  FROM public.reading_chunks_v2 c
  WHERE c.room_id=target_room AND c.chunk_index>=from_index
    AND c.chunk_index<from_index+requested_count
  ORDER BY c.chunk_index;
END;
$$;

REVOKE ALL ON FUNCTION public.v2_upload_book_chunk(uuid,integer,text)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.v2_read_book_chunks(uuid,integer,integer)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.v2_upload_book_chunk(uuid,integer,text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.v2_read_book_chunks(uuid,integer,integer)
  TO authenticated;
