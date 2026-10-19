-- V2 idempotent submission of text notes and replies. Staging ONLY.
-- An operation UUID is generated on the client once per intended message.
-- Network retries with the same UUID cannot create a second row or event.
ALTER TABLE public.reading_highlights_v2
  ADD COLUMN client_operation_id uuid;
ALTER TABLE public.reading_note_replies_v2
  ADD COLUMN client_operation_id uuid;
ALTER TABLE public.reading_highlights_v2
  ADD CONSTRAINT reading_highlights_v2_op_unique
  UNIQUE (room_id,author_id,client_operation_id);
ALTER TABLE public.reading_note_replies_v2
  ADD CONSTRAINT reading_note_replies_v2_op_unique
  UNIQUE (room_id,author_id,client_operation_id);

-- The existing annotation UPDATE permission must not allow rewriting the
-- operation identity after a successful submit.
CREATE FUNCTION public.v2_guard_highlight_operation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=''
AS $$
BEGIN
  IF NEW.client_operation_id IS DISTINCT FROM OLD.client_operation_id THEN
    RAISE EXCEPTION 'Submission operation identity is immutable'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reading_highlights_v2_operation_immutable
BEFORE UPDATE ON public.reading_highlights_v2
FOR EACH ROW EXECUTE FUNCTION public.v2_guard_highlight_operation();

-- Statuses intentionally reveal no record belonging to another user.
-- The original text/visibility is compared before accepting a replay:
-- same UUID + changed content or sharing scope is a conflict, not an edit.
CREATE FUNCTION public.v2_submit_highlight(
  target_room uuid, target_chunk integer, target_start integer,
  target_end integer, target_body text, target_visibility text,
  target_operation uuid
)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  actor uuid := auth.uid();
  original public.reading_highlights_v2%ROWTYPE;
  inserted_id uuid;
BEGIN
  IF actor IS NULL OR target_room IS NULL OR target_operation IS NULL
    OR target_chunk IS NULL OR target_chunk NOT BETWEEN 0 AND 1999
    OR target_start IS NULL OR target_start < 0
    OR target_end IS NULL OR target_end <= target_start OR target_end > 3000
    OR target_body IS NULL
    OR pg_catalog.char_length(pg_catalog.btrim(target_body)) NOT BETWEEN 1 AND 2000
    OR target_visibility IS NULL OR target_visibility NOT IN ('private','shared')
    OR NOT public.v2_can_edit_room(target_room) THEN
    RETURN 'denied';
  END IF;

  SELECT * INTO original FROM public.reading_highlights_v2 h
    WHERE h.room_id=target_room AND h.author_id=actor
      AND h.client_operation_id=target_operation;
  IF FOUND THEN
    RETURN CASE WHEN original.chunk_index=target_chunk
      AND original.start_index=target_start AND original.end_index=target_end
      AND original.body=target_body AND original.visibility=target_visibility
      THEN 'already_saved' ELSE 'conflict' END;
  END IF;

  INSERT INTO public.reading_highlights_v2(
    room_id,chunk_index,author_id,start_index,end_index,
    body,visibility,client_operation_id
  ) VALUES(
    target_room,target_chunk,actor,target_start,target_end,
    target_body,target_visibility,target_operation
  ) ON CONFLICT (room_id,author_id,client_operation_id) DO NOTHING
  RETURNING id INTO inserted_id;
  IF inserted_id IS NOT NULL THEN RETURN 'saved'; END IF;

  SELECT * INTO original FROM public.reading_highlights_v2 h
    WHERE h.room_id=target_room AND h.author_id=actor
      AND h.client_operation_id=target_operation;
  RETURN CASE WHEN FOUND AND original.chunk_index=target_chunk
    AND original.start_index=target_start AND original.end_index=target_end
    AND original.body=target_body AND original.visibility=target_visibility
    THEN 'already_saved' ELSE 'conflict' END;
END;
$$;

CREATE FUNCTION public.v2_submit_reply(
  target_room uuid, target_note uuid, target_body text,
  target_operation uuid
)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  actor uuid := auth.uid();
  original public.reading_note_replies_v2%ROWTYPE;
  inserted_id uuid;
BEGIN
  IF actor IS NULL OR target_room IS NULL OR target_note IS NULL
    OR target_operation IS NULL OR target_body IS NULL
    OR pg_catalog.char_length(pg_catalog.btrim(target_body)) NOT BETWEEN 1 AND 2000
    OR NOT public.v2_can_edit_room(target_room) THEN
    RETURN 'denied';
  END IF;
  -- Replays of a saved submission are resolved before the parent policy or
  -- per-thread capacity checks. A withdrawn reply must stay withdrawn.
  SELECT * INTO original FROM public.reading_note_replies_v2 r
    WHERE r.room_id=target_room AND r.author_id=actor
      AND r.client_operation_id=target_operation;
  IF FOUND THEN
    RETURN CASE
      WHEN original.hidden_at IS NOT NULL THEN 'withdrawn'
      WHEN original.highlight_id=target_note AND original.body=target_body
        THEN 'already_saved' ELSE 'conflict' END;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.reading_highlights_v2 h
    WHERE h.room_id=target_room AND h.id=target_note
      AND (h.author_id=actor OR h.visibility='shared')
  ) THEN
    RETURN 'denied';
  END IF;

  INSERT INTO public.reading_note_replies_v2(
    room_id,highlight_id,author_id,body,client_operation_id
  ) VALUES(target_room,target_note,actor,target_body,target_operation)
  ON CONFLICT (room_id,author_id,client_operation_id) DO NOTHING
  RETURNING id INTO inserted_id;
  IF inserted_id IS NOT NULL THEN RETURN 'saved'; END IF;

  SELECT * INTO original FROM public.reading_note_replies_v2 r
    WHERE r.room_id=target_room AND r.author_id=actor
      AND r.client_operation_id=target_operation;
  RETURN CASE
    WHEN NOT FOUND THEN 'conflict'
    WHEN original.hidden_at IS NOT NULL THEN 'withdrawn'
    WHEN original.highlight_id=target_note AND original.body=target_body
      THEN 'already_saved' ELSE 'conflict' END;
END;
$$;

REVOKE ALL ON FUNCTION public.v2_guard_highlight_operation()
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.v2_submit_highlight(
  uuid,integer,integer,integer,text,text,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.v2_submit_reply(uuid,uuid,text,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.v2_submit_highlight(
  uuid,integer,integer,integer,text,text,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.v2_submit_reply(uuid,uuid,text,uuid)
  TO authenticated;
