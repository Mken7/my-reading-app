-- V2 only: safe resume after uncertain transport failures during an import.
-- An existing immutable chunk is accepted ONLY if it matches exactly.
-- This exposes no book text to an unauthenticated user or a room partner.
CREATE FUNCTION public.v2_upload_book_chunk_retry(
  target_room uuid,target_index integer,chunk_text text
)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $$
DECLARE actor uuid:=auth.uid();
  room_owner uuid;
  state text;
  prior public.reading_chunks_v2%ROWTYPE;
  saved boolean;
BEGIN
  IF actor IS NULL OR target_room IS NULL OR target_index IS NULL OR
     target_index NOT BETWEEN 0 AND 1999 OR chunk_text IS NULL OR
     pg_catalog.char_length(chunk_text) NOT BETWEEN 1 AND 3000 THEN RETURN 'denied'; END IF;

  -- Serialize checks and writes with the legacy trusted upload RPC.
  SELECT r.owner_id,r.state INTO room_owner,state
  FROM public.reading_rooms_v2 r WHERE r.id=target_room FOR UPDATE;
  IF room_owner IS DISTINCT FROM actor OR state IS DISTINCT FROM 'active'
    OR NOT public.v2_is_room_member(target_room) THEN RETURN 'denied'; END IF;

  SELECT * INTO prior FROM public.reading_chunks_v2 c
  WHERE c.room_id=target_room AND c.chunk_index=target_index;
  IF FOUND THEN
    RETURN CASE WHEN prior.body=chunk_text AND prior.uploaded_by=actor
      THEN 'already_saved' ELSE 'conflict' END;
  END IF;

  saved:=public.v2_upload_book_chunk(target_room,target_index,chunk_text);
  RETURN CASE WHEN saved THEN 'saved' ELSE 'quota_or_denied' END;
END;
$$;
REVOKE ALL ON FUNCTION public.v2_upload_book_chunk_retry(uuid,integer,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.v2_upload_book_chunk_retry(uuid,integer,text)
  TO authenticated;
