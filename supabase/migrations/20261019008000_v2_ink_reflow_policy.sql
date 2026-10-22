-- Module 07: drawing reflow layout contract and member revocation.
-- Staging V2 only; existing strokes retain bounding_v1 geometry unchanged.
ALTER TABLE public.reading_ink_v2
  ADD COLUMN anchor_layout text NOT NULL DEFAULT 'bounding_v1'
    CHECK(anchor_layout IN ('bounding_v1','single_line_v2')),
  ADD CONSTRAINT reading_ink_v2_line_anchor_check CHECK (
    anchor_layout<>'single_line_v2'
    OR (anchor_start IS NOT NULL AND anchor_end IS NOT NULL)
  );

-- A former member must not SELECT saved ink after leaving/closing a room,
-- even if they personally authored it. Shared/private rules apply ONLY to
-- active members of the current reading room.
DROP POLICY reading_ink_v2_visible ON public.reading_ink_v2;
CREATE POLICY reading_ink_v2_visible
ON public.reading_ink_v2 FOR SELECT TO authenticated
USING (
  hidden_at IS NULL AND public.v2_can_edit_room(room_id) AND
  (author_id=(SELECT auth.uid()) OR visibility='shared')
);

-- New shapes include the immutable layout contract in the chained audit hash.
-- Earlier v1/v2 audit events remain intact and are not silently rewritten.
CREATE OR REPLACE FUNCTION public.v2_audit_ink_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
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
    'version',3,'id',NEW.id,'room',NEW.room_id,'chunk',NEW.chunk_index,
    'author',NEW.author_id,'kind',NEW.kind,'points',NEW.points,
    'visibility',NEW.visibility,'created_at',NEW.created_at,
    'anchor_start',NEW.anchor_start,'anchor_end',NEW.anchor_end,
    'anchor_layout',NEW.anchor_layout
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
    room_id,sequence_number,actor_id,action,note_id,payload_hash,
    previous_hash,event_hash,occurred_at
  ) VALUES (
    NEW.room_id,event_seq,NEW.author_id,'ink.created',NEW.id,
    payload_digest,previous,event_digest,stamp
  );
  RETURN NEW;
END;
$$;
