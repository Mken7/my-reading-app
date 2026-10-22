-- V2 note replies. Staging only, requires v2_overlap_annotations and v2_ink.
-- A reply inherits the parent text note's visibility. No client may attach
-- comments to a hidden private note or modify another user's messages.

ALTER TABLE public.reading_highlights_v2
ADD CONSTRAINT reading_highlights_v2_room_note_unique UNIQUE(room_id,id);

CREATE TABLE public.reading_note_replies_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL,
  highlight_id uuid NOT NULL,
  author_id uuid NOT NULL,
  body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(room_id,highlight_id)
    REFERENCES public.reading_highlights_v2(room_id,id),
  FOREIGN KEY(room_id,author_id)
    REFERENCES public.reading_members_v2(room_id,user_id)
);
CREATE INDEX reading_note_replies_v2_by_note
  ON public.reading_note_replies_v2(room_id,highlight_id,created_at);

ALTER TABLE public.reading_note_replies_v2 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reading_note_replies_v2 FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON public.reading_note_replies_v2 TO authenticated;

CREATE POLICY reading_note_replies_v2_select
ON public.reading_note_replies_v2 FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.reading_highlights_v2 h
  WHERE h.room_id=public.reading_note_replies_v2.room_id
    AND h.id=public.reading_note_replies_v2.highlight_id
    AND (h.author_id=(SELECT auth.uid()) OR
         (h.visibility='shared' AND public.v2_is_room_member(h.room_id)))
));
CREATE POLICY reading_note_replies_v2_insert
ON public.reading_note_replies_v2 FOR INSERT TO authenticated
WITH CHECK (
  author_id=(SELECT auth.uid()) AND public.v2_can_edit_room(room_id)
  AND EXISTS (
    SELECT 1 FROM public.reading_highlights_v2 h
    WHERE h.room_id=public.reading_note_replies_v2.room_id
    AND h.id=public.reading_note_replies_v2.highlight_id
      AND (h.author_id=(SELECT auth.uid()) OR h.visibility='shared')
  )
);

CREATE FUNCTION public.v2_guard_note_reply()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  total integer;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(NEW.highlight_id::text, 29810)
  );
  SELECT count(*) INTO total
  FROM public.reading_note_replies_v2 r
  WHERE r.highlight_id=NEW.highlight_id AND r.room_id=NEW.room_id;
  IF total >= 100 THEN
    RAISE EXCEPTION 'Reply limit reached' USING ERRCODE='23514';
  END IF;
  NEW.created_at:=now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER reading_note_replies_v2_validate
BEFORE INSERT ON public.reading_note_replies_v2
FOR EACH ROW EXECUTE FUNCTION public.v2_guard_note_reply();

ALTER TABLE public.reading_audit_v2
DROP CONSTRAINT reading_audit_v2_action_check;
ALTER TABLE public.reading_audit_v2
ADD CONSTRAINT reading_audit_v2_action_check
CHECK (action IN ('note.created','note.updated',
                 'highlight.created','highlight.updated','ink.created',
                 'reply.created'));

CREATE FUNCTION public.v2_audit_reply_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  previous_seq bigint;
  previous_digest text;
  current_seq bigint;
  payload_json text;
  content_hash text;
  timestamp_event timestamptz;
  event_json text;
  event_hash_value text;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(NEW.room_id::text,14791)
  );
  SELECT a.sequence_number,a.event_hash INTO previous_seq,previous_digest
  FROM public.reading_audit_v2 a WHERE a.room_id=NEW.room_id
  ORDER BY a.sequence_number DESC LIMIT 1;
  current_seq:=COALESCE(previous_seq,0)+1;
  previous_digest:=COALESCE(previous_digest,repeat('0',64));
  timestamp_event:=pg_catalog.clock_timestamp();
  payload_json:=pg_catalog.jsonb_build_object(
    'version',1,'id',NEW.id,'room',NEW.room_id,
    'highlight_id',NEW.highlight_id,'author',NEW.author_id,
    'body',NEW.body,'created_at',NEW.created_at
  )::text;
  content_hash:=pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(payload_json,'UTF8')),'hex');
  event_json:=pg_catalog.jsonb_build_object(
    'version',1,'room',NEW.room_id,'sequence',current_seq,
    'actor',NEW.author_id,'kind','reply.created','note',NEW.id,
    'payload_hash',content_hash,'previous_hash',previous_digest,
    'occurred_at',timestamp_event
  )::text;
  event_hash_value:=pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(event_json,'UTF8')),'hex');
  INSERT INTO public.reading_audit_v2(
    room_id,sequence_number,actor_id,action,note_id,
    payload_hash,previous_hash,event_hash,occurred_at
  ) VALUES(
    NEW.room_id,current_seq,NEW.author_id,'reply.created',NEW.id,
    content_hash,previous_digest,event_hash_value,timestamp_event
  );
  RETURN NEW;
END;
$$;
CREATE TRIGGER reading_note_replies_v2_audit
AFTER INSERT ON public.reading_note_replies_v2
FOR EACH ROW EXECUTE FUNCTION public.v2_audit_reply_insert();
REVOKE ALL ON FUNCTION public.v2_guard_note_reply()
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.v2_audit_reply_insert()
  FROM PUBLIC,anon,authenticated;
