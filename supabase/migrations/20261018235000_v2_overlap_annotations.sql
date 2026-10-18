-- V2 independently overlapping per-chunk annotations, private/shared visibility
-- and append-only audit events. Staging-only: requires preceding V2 migrations.
-- Annotation boundaries are Unicode *code-point* offsets into one immutable
-- chunk. No exclusion/overlap constraint: two users may highlight any span.

CREATE TABLE public.reading_highlights_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL,
  chunk_index integer NOT NULL CHECK(chunk_index BETWEEN 0 AND 1999),
  author_id uuid NOT NULL,
  start_index integer NOT NULL CHECK(start_index >= 0),
  end_index integer NOT NULL CHECK(end_index > start_index AND end_index <= 3000),
  body text NOT NULL CHECK(char_length(btrim(body)) BETWEEN 1 AND 2000),
  visibility text NOT NULL DEFAULT 'private'
    CHECK(visibility IN ('private','shared')),
  revision bigint NOT NULL DEFAULT 1 CHECK(revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(room_id,chunk_index)
    REFERENCES public.reading_chunks_v2(room_id,chunk_index),
  FOREIGN KEY(room_id,author_id)
    REFERENCES public.reading_members_v2(room_id,user_id)
);
CREATE INDEX reading_highlights_v2_room_chunk
  ON public.reading_highlights_v2(room_id,chunk_index,created_at);

ALTER TABLE public.reading_highlights_v2 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reading_highlights_v2 FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.reading_highlights_v2 TO authenticated;

CREATE POLICY reading_highlights_v2_select
ON public.reading_highlights_v2 FOR SELECT TO authenticated
USING (
  author_id=(SELECT auth.uid())
  OR (visibility='shared' AND public.v2_is_room_member(room_id))
);

CREATE POLICY reading_highlights_v2_insert
ON public.reading_highlights_v2 FOR INSERT TO authenticated
WITH CHECK (
  author_id=(SELECT auth.uid())
  AND public.v2_can_edit_room(room_id)
);

CREATE POLICY reading_highlights_v2_update
ON public.reading_highlights_v2 FOR UPDATE TO authenticated
USING (author_id=(SELECT auth.uid()) AND public.v2_can_edit_room(room_id))
WITH CHECK(author_id=(SELECT auth.uid()) AND public.v2_can_edit_room(room_id));

-- Verify chosen range against the *actual* immutable text, not just a UI
-- length. Author/id/anchor provenance cannot be changed by updates.
CREATE FUNCTION public.v2_guard_highlight()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  content_length integer;
BEGIN
  IF TG_OP='UPDATE' AND (
    NEW.id IS DISTINCT FROM OLD.id OR
    NEW.room_id IS DISTINCT FROM OLD.room_id OR
    NEW.chunk_index IS DISTINCT FROM OLD.chunk_index OR
    NEW.author_id IS DISTINCT FROM OLD.author_id OR
    NEW.start_index IS DISTINCT FROM OLD.start_index OR
    NEW.end_index IS DISTINCT FROM OLD.end_index OR
    NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Annotation identity and anchor cannot be changed'
      USING ERRCODE='23514';
  END IF;

  SELECT char_length(c.body) INTO content_length
  FROM public.reading_chunks_v2 c
  WHERE c.room_id=NEW.room_id AND c.chunk_index=NEW.chunk_index;
  IF content_length IS NULL OR NEW.end_index > content_length THEN
    RAISE EXCEPTION 'Annotation range exceeds actual paragraph'
      USING ERRCODE='23514';
  END IF;

  IF TG_OP='UPDATE' THEN
    NEW.revision := OLD.revision+1;
    NEW.updated_at := now();
  ELSE
    NEW.revision := 1;
    NEW.created_at := now();
    NEW.updated_at := NEW.created_at;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reading_highlights_v2_validate
BEFORE INSERT OR UPDATE ON public.reading_highlights_v2
FOR EACH ROW EXECUTE FUNCTION public.v2_guard_highlight();

-- Reuse the existing V2 room hash-chain with explicit highlight event types.
-- The chain is still only tamper-evident while its head is NOT independently
-- signed/anchored. Plaintext is never stored in the audit table.
ALTER TABLE public.reading_audit_v2
DROP CONSTRAINT reading_audit_v2_action_check;
ALTER TABLE public.reading_audit_v2
ADD CONSTRAINT reading_audit_v2_action_check
CHECK(action IN (
  'note.created','note.updated','highlight.created','highlight.updated'
));

CREATE FUNCTION public.v2_audit_highlight_mutation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  prior_seq bigint;
  prior_hash text;
  next_seq bigint;
  action_name text;
  payload text;
  payload_digest text;
  stamp timestamptz;
  event_payload text;
  digest_hex text;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(NEW.room_id::text,14791)
  );
  SELECT a.sequence_number,a.event_hash INTO prior_seq,prior_hash
  FROM public.reading_audit_v2 a
  WHERE a.room_id=NEW.room_id
  ORDER BY a.sequence_number DESC LIMIT 1;

  next_seq := COALESCE(prior_seq,0)+1;
  prior_hash := COALESCE(prior_hash,repeat('0',64));
  action_name := CASE WHEN TG_OP='INSERT' THEN 'highlight.created'
                      ELSE 'highlight.updated' END;
  stamp := pg_catalog.clock_timestamp();
  payload := pg_catalog.jsonb_build_object(
    'version',1,'id',NEW.id,'room',NEW.room_id,'chunk_index',NEW.chunk_index,
    'author',NEW.author_id,'start',NEW.start_index,'end',NEW.end_index,
    'body',NEW.body,'visibility',NEW.visibility,'revision',NEW.revision,
    'created_at',NEW.created_at,'updated_at',NEW.updated_at
  )::text;
  payload_digest := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(payload,'UTF8')),'hex');
  event_payload := pg_catalog.jsonb_build_object(
    'version',1,'room',NEW.room_id,'sequence',next_seq,
    'actor',NEW.author_id,'kind',action_name,'note',NEW.id,
    'payload_hash',payload_digest,'previous_hash',prior_hash,
    'occurred_at',stamp
  )::text;
  digest_hex := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(event_payload,'UTF8')),'hex');

  INSERT INTO public.reading_audit_v2(
    room_id,sequence_number,actor_id,action,note_id,
    payload_hash,previous_hash,event_hash,occurred_at
  ) VALUES (
    NEW.room_id,next_seq,NEW.author_id,action_name,NEW.id,
    payload_digest,prior_hash,digest_hex,stamp
  );
  RETURN NEW;
END;
$$;
CREATE TRIGGER reading_highlights_v2_audit
AFTER INSERT OR UPDATE ON public.reading_highlights_v2
FOR EACH ROW EXECUTE FUNCTION public.v2_audit_highlight_mutation();

REVOKE ALL ON FUNCTION public.v2_guard_highlight()
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.v2_audit_highlight_mutation()
  FROM PUBLIC,anon,authenticated;
