-- Module 08: character-precise private reading position, V2 staging only.
-- Unicode coordinates are PostgreSQL char_length code points, not JS UTF-16.
ALTER TABLE public.reading_progress_v2
  ADD COLUMN char_offset integer NOT NULL DEFAULT 0
  CHECK (char_offset BETWEEN 0 AND 3000);

CREATE FUNCTION public.v2_get_reading_position(target_room uuid)
RETURNS TABLE(chunk_index integer,char_offset integer,revision bigint,updated_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=''
AS $$
DECLARE actor uuid:=auth.uid();
BEGIN
  IF actor IS NULL OR NOT public.v2_can_edit_room(target_room) THEN RETURN; END IF;
  RETURN QUERY SELECT p.chunk_index,p.char_offset,p.revision,p.updated_at
    FROM public.reading_progress_v2 p WHERE p.room_id=target_room AND p.user_id=actor;
END;
$$;

CREATE FUNCTION public.v2_save_reading_position(
  target_room uuid,target_chunk integer,target_offset integer,expected_revision bigint
)
RETURNS TABLE(saved boolean,chunk_index integer,char_offset integer,revision bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $$
DECLARE
 actor uuid:=auth.uid();
 new_chunk integer;
 new_offset integer;
 new_revision bigint;
 current_chunk integer;
 current_offset integer;
 current_revision bigint;
 text_length integer;
BEGIN
  IF actor IS NULL OR expected_revision IS NULL OR expected_revision<0 OR
    target_chunk IS NULL OR target_chunk NOT BETWEEN 0 AND 1999 OR
    target_offset IS NULL OR target_offset<0 OR target_offset>3000 OR
    NOT public.v2_can_edit_room(target_room) THEN RETURN; END IF;
  SELECT pg_catalog.char_length(c.body) INTO text_length
  FROM public.reading_chunks_v2 c
  WHERE c.room_id=target_room AND c.chunk_index=target_chunk;
  IF text_length IS NULL OR target_offset>text_length THEN RETURN; END IF;
  IF expected_revision=0 THEN
    INSERT INTO public.reading_progress_v2
      (room_id,user_id,chunk_index,char_offset,revision)
    VALUES(target_room,actor,target_chunk,target_offset,1)
    ON CONFLICT (room_id,user_id) DO NOTHING
    RETURNING public.reading_progress_v2.chunk_index,
      public.reading_progress_v2.char_offset,
      public.reading_progress_v2.revision INTO new_chunk,new_offset,new_revision;
  ELSE
    UPDATE public.reading_progress_v2 p
    SET chunk_index=target_chunk,char_offset=target_offset,
      revision=p.revision+1,updated_at=pg_catalog.now()
    WHERE p.room_id=target_room AND p.user_id=actor
      AND p.revision=expected_revision
    RETURNING p.chunk_index,p.char_offset,p.revision
    INTO new_chunk,new_offset,new_revision;
  END IF;
  IF new_revision IS NOT NULL THEN
    RETURN QUERY SELECT true,new_chunk,new_offset,new_revision;
    RETURN;
  END IF;
  SELECT p.chunk_index,p.char_offset,p.revision
    INTO current_chunk,current_offset,current_revision
  FROM public.reading_progress_v2 p
  WHERE p.room_id=target_room AND p.user_id=actor;
  IF FOUND THEN
    RETURN QUERY SELECT false,current_chunk,current_offset,current_revision;
  ELSE
    RETURN QUERY SELECT false,NULL::integer,NULL::integer,0::bigint;
  END IF;
END;
$$;

-- Keep the legacy three-argument cursor RPC usable for older V2 previews:
-- it must reset offset to 0 instead of retaining an offset from another chunk.
CREATE OR REPLACE FUNCTION public.v2_save_reading_progress(
  target_room uuid,target_chunk integer,expected_revision bigint
)
RETURNS TABLE(saved boolean,chunk_index integer,revision bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $$
BEGIN
  RETURN QUERY SELECT p.saved,p.chunk_index,p.revision
  FROM public.v2_save_reading_position(target_room,target_chunk,0,expected_revision) p;
END;
$$;

REVOKE ALL ON FUNCTION public.v2_get_reading_position(uuid)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.v2_save_reading_position(uuid,integer,integer,bigint)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.v2_get_reading_position(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.v2_save_reading_position(uuid,integer,integer,bigint)
  TO authenticated;
