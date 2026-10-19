-- Staging-only V2 text-relative ink anchors.
-- Existing normalized, paragraph-relative ink stays valid (both anchors NULL).
-- New ink may be tied to an immutable codepoint range in the paragraph.
ALTER TABLE public.reading_ink_v2
  ADD COLUMN anchor_start integer,
  ADD COLUMN anchor_end integer;

ALTER TABLE public.reading_ink_v2
  ADD CONSTRAINT reading_ink_v2_anchor_pair_check
  CHECK (
    (anchor_start IS NULL AND anchor_end IS NULL)
    OR (anchor_start IS NOT NULL AND anchor_end IS NOT NULL
        AND anchor_start >= 0 AND anchor_end > anchor_start AND anchor_end <= 3000)
  );

CREATE FUNCTION public.v2_guard_ink_anchor()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  paragraph_length integer;
BEGIN
  IF NEW.anchor_start IS NOT NULL THEN
    SELECT pg_catalog.char_length(c.body) INTO paragraph_length
    FROM public.reading_chunks_v2 c
    WHERE c.room_id=NEW.room_id AND c.chunk_index=NEW.chunk_index;
    IF paragraph_length IS NULL OR NEW.anchor_end > paragraph_length THEN
      RAISE EXCEPTION 'Ink text anchor exceeds immutable paragraph'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER reading_ink_v2_anchor_guard
BEFORE INSERT ON public.reading_ink_v2
FOR EACH ROW EXECUTE FUNCTION public.v2_guard_ink_anchor();

REVOKE ALL ON FUNCTION public.v2_guard_ink_anchor()
  FROM PUBLIC,anon,authenticated;

-- Audit content digest includes anchoring metadata, without storing text
-- or drawing coordinates in the audit row.
CREATE OR REPLACE FUNCTION public.v2_audit_ink_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  last_seq bigint;
  previous text;
  event_seq bigint;
  payload text;
  payload_digest text;
  stamp timestamptz;
  event_json text;
  event_digest text;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(NEW.room_id::text,14791)
  );
  SELECT a.sequence_number,a.event_hash INTO last_seq,previous
  FROM public.reading_audit_v2 a
  WHERE a.room_id=NEW.room_id
  ORDER BY a.sequence_number DESC LIMIT 1;

  event_seq:=COALESCE(last_seq,0)+1;
  previous:=COALESCE(previous,repeat('0',64));
  stamp:=pg_catalog.clock_timestamp();
  payload:=pg_catalog.jsonb_build_object(
    'version',2,'id',NEW.id,'room',NEW.room_id,'chunk',NEW.chunk_index,
    'author',NEW.author_id,'kind',NEW.kind,'points',NEW.points,
    'visibility',NEW.visibility,'created_at',NEW.created_at,
    'anchor_start',NEW.anchor_start,'anchor_end',NEW.anchor_end
  )::text;
  payload_digest:=pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(payload,'UTF8')),'hex'
  );
  event_json:=pg_catalog.jsonb_build_object(
    'version',1,'room',NEW.room_id,'sequence',event_seq,
    'actor',NEW.author_id,'kind','ink.created','note',NEW.id,
    'payload_hash',payload_digest,'previous_hash',previous,
    'occurred_at',stamp
  )::text;
  event_digest:=pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(event_json,'UTF8')),'hex'
  );
  INSERT INTO public.reading_audit_v2 (
    room_id,sequence_number,actor_id,action,note_id,
    payload_hash,previous_hash,event_hash,occurred_at
  ) VALUES (
    NEW.room_id,event_seq,NEW.author_id,'ink.created',NEW.id,
    payload_digest,previous,event_digest,stamp
  );
  RETURN NEW;
END;
$$;
