-- Independent per-reader visual ink, tied to one immutable book chunk.
-- Staging-only migration. Requires reading_audit_v2 and reading_chunks_v2.
-- Normalized (0..1000) overlay geometry, NOT a promise of pixel-perfect
-- anchoring when readers use different fonts or window sizes.

CREATE TABLE public.reading_ink_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL,
  chunk_index integer NOT NULL CHECK (chunk_index BETWEEN 0 AND 1999),
  author_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('stroke','ellipse','arrow')),
  points jsonb NOT NULL CHECK (jsonb_typeof(points)='array'),
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','shared')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (room_id,chunk_index)
    REFERENCES public.reading_chunks_v2(room_id,chunk_index),
  FOREIGN KEY (room_id,author_id)
    REFERENCES public.reading_members_v2(room_id,user_id)
);
CREATE INDEX reading_ink_v2_by_chunk ON public.reading_ink_v2
  (room_id,chunk_index,created_at);
ALTER TABLE public.reading_ink_v2 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reading_ink_v2 FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON public.reading_ink_v2 TO authenticated;

CREATE POLICY reading_ink_v2_visible
ON public.reading_ink_v2 FOR SELECT TO authenticated
USING (
  author_id=(SELECT auth.uid())
  OR (visibility='shared' AND public.v2_is_room_member(room_id))
);
CREATE POLICY reading_ink_v2_insert
ON public.reading_ink_v2 FOR INSERT TO authenticated
WITH CHECK (
  author_id=(SELECT auth.uid()) AND public.v2_can_edit_room(room_id)
);

CREATE FUNCTION public.v2_guard_ink_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  point jsonb;
  count_points integer;
  existing_count integer;
BEGIN
  count_points := jsonb_array_length(NEW.points);
  IF count_points < 2 OR count_points > 128 OR
      (NEW.kind IN ('ellipse','arrow') AND count_points <> 2) THEN
    RAISE EXCEPTION 'Ink points invalid' USING ERRCODE='23514';
  END IF;
  FOR point IN SELECT value FROM jsonb_array_elements(NEW.points) LOOP
    IF jsonb_typeof(point) <> 'object'
       OR NOT (point ? 'x') OR NOT (point ? 'y')
       OR jsonb_typeof(point->'x') <> 'number'
       OR jsonb_typeof(point->'y') <> 'number'
       OR (point->>'x') !~ '^[0-9]{1,4}$'
       OR (point->>'y') !~ '^[0-9]{1,4}$'
       OR (point->>'x')::integer > 1000
       OR (point->>'y')::integer > 1000
    THEN
      RAISE EXCEPTION 'Ink point out of bounds' USING ERRCODE='23514';
    END IF;
  END LOOP;
  -- Serialize quotas for the same author/room/chunk even under concurrent
  -- transactions. Prevent unbounded client writes and rendering overload.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      NEW.room_id::text || ':' || NEW.chunk_index::text ||
      ':' || NEW.author_id::text, 10477
    )
  );
  SELECT count(*) INTO existing_count FROM public.reading_ink_v2 i
   WHERE i.room_id=NEW.room_id AND i.chunk_index=NEW.chunk_index
   AND i.author_id=NEW.author_id;
  IF existing_count >= 60 THEN
    RAISE EXCEPTION 'Ink limit reached' USING ERRCODE='23514';
  END IF;
  -- Prevent caller-controlled timestamps on inserts.
  NEW.created_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER reading_ink_v2_validate
BEFORE INSERT ON public.reading_ink_v2
FOR EACH ROW EXECUTE FUNCTION public.v2_guard_ink_insert();

ALTER TABLE public.reading_audit_v2
DROP CONSTRAINT reading_audit_v2_action_check;
ALTER TABLE public.reading_audit_v2
ADD CONSTRAINT reading_audit_v2_action_check
CHECK(action IN ('note.created','note.updated',
                 'highlight.created','highlight.updated','ink.created'));

CREATE FUNCTION public.v2_audit_ink_insert()
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
    'version',1,'id',NEW.id,'room',NEW.room_id,'chunk',NEW.chunk_index,
    'author',NEW.author_id,'kind',NEW.kind,'points',NEW.points,
    'visibility',NEW.visibility,'created_at',NEW.created_at
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
CREATE TRIGGER reading_ink_v2_audit
AFTER INSERT ON public.reading_ink_v2
FOR EACH ROW EXECUTE FUNCTION public.v2_audit_ink_insert();

REVOKE ALL ON FUNCTION public.v2_guard_ink_insert()
 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.v2_audit_ink_insert()
 FROM PUBLIC,anon,authenticated;
