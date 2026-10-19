-- Module 06: audited author-owned note editing, retraction and reply privacy.
-- Apply to isolated V2 staging only, after 20261019008000_v2_ink_reflow_policy.
ALTER TABLE public.reading_highlights_v2
  ADD COLUMN hidden_at timestamptz,
  ADD COLUMN hidden_by uuid REFERENCES auth.users(id),
  ADD CONSTRAINT reading_highlights_v2_hidden_pair CHECK (
    (hidden_at IS NULL AND hidden_by IS NULL) OR
    (hidden_at IS NOT NULL AND hidden_by=author_id)
  );

-- Clients may INSERT and read their permitted notes but never issue raw UPDATE.
-- Trusted optimistic concurrency RPCs own every edit and soft retraction.
REVOKE UPDATE ON public.reading_highlights_v2 FROM authenticated;

DROP POLICY reading_highlights_v2_select ON public.reading_highlights_v2;
CREATE POLICY reading_highlights_v2_select
ON public.reading_highlights_v2 FOR SELECT TO authenticated
USING (
  hidden_at IS NULL AND public.v2_can_edit_room(room_id)
  AND (author_id=(SELECT auth.uid()) OR visibility='shared')
);

DROP POLICY reading_note_replies_v2_select ON public.reading_note_replies_v2;
CREATE POLICY reading_note_replies_v2_select
ON public.reading_note_replies_v2 FOR SELECT TO authenticated
USING (
  hidden_at IS NULL AND public.v2_can_edit_room(room_id)
  AND EXISTS (
    SELECT 1 FROM public.reading_highlights_v2 h
    WHERE h.room_id=public.reading_note_replies_v2.room_id
      AND h.id=public.reading_note_replies_v2.highlight_id
      AND h.hidden_at IS NULL
      AND (h.author_id=(SELECT auth.uid()) OR h.visibility='shared')
  )
);

DROP POLICY reading_note_replies_v2_insert ON public.reading_note_replies_v2;
CREATE POLICY reading_note_replies_v2_insert
ON public.reading_note_replies_v2 FOR INSERT TO authenticated
WITH CHECK (
  author_id=(SELECT auth.uid()) AND public.v2_can_edit_room(room_id)
  AND EXISTS (
    SELECT 1 FROM public.reading_highlights_v2 h
    WHERE h.room_id=public.reading_note_replies_v2.room_id
      AND h.id=public.reading_note_replies_v2.highlight_id
      AND h.hidden_at IS NULL
      AND (h.author_id=(SELECT auth.uid()) OR h.visibility='shared')
  )
);

ALTER TABLE public.reading_audit_v2
DROP CONSTRAINT reading_audit_v2_action_check;
ALTER TABLE public.reading_audit_v2
ADD CONSTRAINT reading_audit_v2_action_check
CHECK (action IN ('note.created','note.updated','highlight.created',
  'highlight.updated','highlight.hidden','ink.created','reply.created',
  'ink.hidden','reply.hidden'));

-- Preserve the old hash chain. New highlight operations use payload v2 and
-- record tombstones in the digest; audit still never stores note plaintext.
CREATE OR REPLACE FUNCTION public.v2_audit_highlight_mutation()
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
  next_seq:=COALESCE(prior_seq,0)+1;
  prior_hash:=COALESCE(prior_hash,repeat('0',64));
  action_name:=CASE
    WHEN TG_OP='INSERT' THEN 'highlight.created'
    WHEN OLD.hidden_at IS NULL AND NEW.hidden_at IS NOT NULL
      THEN 'highlight.hidden'
    ELSE 'highlight.updated' END;
  stamp:=pg_catalog.clock_timestamp();
  payload:=pg_catalog.jsonb_build_object(
    'version',2,'id',NEW.id,'room',NEW.room_id,
    'chunk_index',NEW.chunk_index,'author',NEW.author_id,
    'start',NEW.start_index,'end',NEW.end_index,
    'body',NEW.body,'visibility',NEW.visibility,
    'revision',NEW.revision,'created_at',NEW.created_at,
    'updated_at',NEW.updated_at,'hidden_at',NEW.hidden_at,
    'hidden_by',NEW.hidden_by
  )::text;
  payload_digest:=pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(payload,'UTF8')),'hex');
  event_payload:=pg_catalog.jsonb_build_object(
    'version',1,'room',NEW.room_id,'sequence',next_seq,
    'actor',NEW.author_id,'kind',action_name,'note',NEW.id,
    'payload_hash',payload_digest,'previous_hash',prior_hash,
    'occurred_at',stamp
  )::text;
  digest_hex:=pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(event_payload,'UTF8')),'hex');
  INSERT INTO public.reading_audit_v2(
    room_id,sequence_number,actor_id,action,note_id,
    payload_hash,previous_hash,event_hash,occurred_at
  ) VALUES(NEW.room_id,next_seq,NEW.author_id,action_name,NEW.id,
    payload_digest,prior_hash,digest_hex,stamp);
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.v2_edit_highlight(
  target_room uuid,target_note uuid,target_body text,
  target_visibility text,expected_revision bigint
)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $$
DECLARE actor uuid:=auth.uid();
  original public.reading_highlights_v2%ROWTYPE;
  updated_id uuid;
BEGIN
  IF actor IS NULL OR target_room IS NULL OR target_note IS NULL OR
     expected_revision IS NULL OR expected_revision<1 OR
     target_body IS NULL OR
     pg_catalog.char_length(pg_catalog.btrim(target_body)) NOT BETWEEN 1 AND 2000 OR
     target_visibility IS NULL OR target_visibility NOT IN ('private','shared') OR
     NOT public.v2_can_edit_room(target_room) THEN
    RETURN 'denied';
  END IF;
  SELECT * INTO original FROM public.reading_highlights_v2 h
  WHERE h.room_id=target_room AND h.id=target_note
    AND h.author_id=actor;
  IF NOT FOUND THEN RETURN 'denied'; END IF;
  IF original.hidden_at IS NOT NULL THEN RETURN 'withdrawn'; END IF;
  IF original.revision<>expected_revision THEN RETURN 'conflict'; END IF;

  -- A parent's visibility affects replies. Never expose private replies
  -- by sharing them later or hide a partner's contribution by privatizing.
  IF target_visibility<>original.visibility AND EXISTS (
    SELECT 1 FROM public.reading_note_replies_v2 r
    WHERE r.room_id=target_room AND r.highlight_id=target_note
  ) THEN RETURN 'replies_locked'; END IF;
  IF original.body=target_body AND original.visibility=target_visibility
    THEN RETURN 'unchanged'; END IF;

  UPDATE public.reading_highlights_v2 h
  SET body=target_body,visibility=target_visibility
  WHERE h.room_id=target_room AND h.id=target_note
    AND h.author_id=actor AND h.revision=expected_revision
    AND h.hidden_at IS NULL
  RETURNING h.id INTO updated_id;
  IF updated_id IS NULL THEN RETURN 'conflict'; END IF;
  RETURN 'saved';
END;
$$;

CREATE FUNCTION public.v2_hide_highlight(
  target_room uuid,target_note uuid
)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $$
DECLARE actor uuid:=auth.uid();
  updated_id uuid;
BEGIN
  IF actor IS NULL OR target_room IS NULL OR target_note IS NULL OR
     NOT public.v2_can_edit_room(target_room) THEN RETURN false; END IF;

  -- The parent hide tombstone makes all descendant replies inaccessible,
  -- including to their own authors; underlying data remain for retention.
  UPDATE public.reading_highlights_v2 h
  SET hidden_at=pg_catalog.clock_timestamp(),hidden_by=actor
  WHERE h.room_id=target_room AND h.id=target_note
    AND h.author_id=actor AND h.hidden_at IS NULL
  RETURNING h.id INTO updated_id;
  RETURN updated_id IS NOT NULL;
END;
$$;

-- Replays of the original submission cannot resurrect a withdrawn note.
CREATE OR REPLACE FUNCTION public.v2_submit_highlight(
  target_room uuid,target_chunk integer,target_start integer,
  target_end integer,target_body text,target_visibility text,
  target_operation uuid
)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=''
AS $$
DECLARE actor uuid:=auth.uid();
  original public.reading_highlights_v2%ROWTYPE;
  inserted_id uuid;
BEGIN
  IF actor IS NULL OR target_room IS NULL OR target_operation IS NULL
    OR target_chunk IS NULL OR target_chunk NOT BETWEEN 0 AND 1999
    OR target_start IS NULL OR target_start<0
    OR target_end IS NULL OR target_end<=target_start OR target_end>3000
    OR target_body IS NULL
    OR pg_catalog.char_length(pg_catalog.btrim(target_body)) NOT BETWEEN 1 AND 2000
    OR target_visibility IS NULL OR target_visibility NOT IN ('private','shared')
    OR NOT public.v2_can_edit_room(target_room) THEN RETURN 'denied'; END IF;

  SELECT * INTO original FROM public.reading_highlights_v2 h
    WHERE h.room_id=target_room AND h.author_id=actor
      AND h.client_operation_id=target_operation;
  IF FOUND THEN RETURN CASE
    WHEN original.hidden_at IS NOT NULL THEN 'withdrawn'
    WHEN original.chunk_index=target_chunk AND
      original.start_index=target_start AND original.end_index=target_end AND
      original.visibility=target_visibility AND original.body=target_body
      THEN 'already_saved'
    ELSE 'conflict' END; END IF;

  INSERT INTO public.reading_highlights_v2(
    room_id,chunk_index,author_id,start_index,end_index,
    body,visibility,client_operation_id
  ) VALUES(target_room,target_chunk,actor,target_start,target_end,
      target_body,target_visibility,target_operation)
  ON CONFLICT(room_id,author_id,client_operation_id) DO NOTHING
  RETURNING id INTO inserted_id;
  IF inserted_id IS NOT NULL THEN RETURN 'saved'; END IF;

  SELECT * INTO original FROM public.reading_highlights_v2 h
    WHERE h.room_id=target_room AND h.author_id=actor
      AND h.client_operation_id=target_operation;
  RETURN CASE
    WHEN NOT FOUND THEN 'conflict'
    WHEN original.hidden_at IS NOT NULL THEN 'withdrawn'
    WHEN original.chunk_index=target_chunk AND
      original.start_index=target_start AND original.end_index=target_end AND
      original.visibility=target_visibility AND original.body=target_body
      THEN 'already_saved'
    ELSE 'conflict' END;
END;
$$;

-- Remove the legacy ability to directly change note visibility/body through
-- SQL; RLS is still enforced for reads and insert checks.
REVOKE ALL ON FUNCTION public.v2_edit_highlight(uuid,uuid,text,text,bigint)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.v2_hide_highlight(uuid,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.v2_edit_highlight(uuid,uuid,text,text,bigint)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.v2_hide_highlight(uuid,uuid)
  TO authenticated;
