-- V2 user-initiated hiding of saved ink/replies with append-only audit.
-- Staging-only. Reversible display hiding is NOT legal erasure: original data
-- remains privately retained for consistency and audit/retention review.
ALTER TABLE public.reading_ink_v2
  ADD COLUMN hidden_at timestamptz,
  ADD COLUMN hidden_by uuid REFERENCES auth.users(id),
  ADD CONSTRAINT reading_ink_v2_hidden_pair CHECK (
    (hidden_at IS NULL AND hidden_by IS NULL)
    OR (hidden_at IS NOT NULL AND hidden_by=author_id)
  );

ALTER TABLE public.reading_note_replies_v2
  ADD COLUMN hidden_at timestamptz,
  ADD COLUMN hidden_by uuid REFERENCES auth.users(id),
  ADD CONSTRAINT reading_note_replies_v2_hidden_pair CHECK (
    (hidden_at IS NULL AND hidden_by IS NULL)
    OR (hidden_at IS NOT NULL AND hidden_by=author_id)
  );

-- Server and UI exclude hidden material; no UPDATE or DELETE is granted to
-- ordinary authenticated clients on either table.
DROP POLICY reading_ink_v2_visible ON public.reading_ink_v2;
CREATE POLICY reading_ink_v2_visible
ON public.reading_ink_v2 FOR SELECT TO authenticated
USING (
  hidden_at IS NULL AND (
    author_id=(SELECT auth.uid())
    OR (visibility='shared' AND public.v2_is_room_member(room_id))
  )
);
DROP POLICY reading_note_replies_v2_select ON public.reading_note_replies_v2;
CREATE POLICY reading_note_replies_v2_select
ON public.reading_note_replies_v2 FOR SELECT TO authenticated
USING (
  hidden_at IS NULL AND EXISTS (
    SELECT 1 FROM public.reading_highlights_v2 h
    WHERE h.room_id=public.reading_note_replies_v2.room_id
      AND h.id=public.reading_note_replies_v2.highlight_id
      AND (h.author_id=(SELECT auth.uid()) OR
        (h.visibility='shared' AND public.v2_is_room_member(h.room_id)))
  )
);

ALTER TABLE public.reading_audit_v2
DROP CONSTRAINT reading_audit_v2_action_check;
ALTER TABLE public.reading_audit_v2
ADD CONSTRAINT reading_audit_v2_action_check
CHECK (action IN ('note.created','note.updated','highlight.created',
  'highlight.updated','ink.created','reply.created','ink.hidden','reply.hidden'));

-- Trusted append-only chain writer used exclusively from hide RPCs.
-- No deleted message plaintext or drawing geometry goes into the audit table.
CREATE FUNCTION public.v2_append_hide_audit(
  target_room uuid, target_id uuid, target_actor uuid,
  target_action text, hidden_stamp timestamptz
)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  previous_sequence bigint;
  previous_hash text;
  new_sequence bigint;
  data_hash text;
  event_stamp timestamptz;
  event_hash_value text;
BEGIN
  IF target_action NOT IN ('ink.hidden','reply.hidden')
     OR target_room IS NULL OR target_id IS NULL
     OR target_actor IS NULL OR hidden_stamp IS NULL THEN
    RAISE EXCEPTION 'Invalid hide audit payload' USING ERRCODE='22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_room::text,14791)
  );
  SELECT a.sequence_number,a.event_hash INTO previous_sequence,previous_hash
  FROM public.reading_audit_v2 a WHERE a.room_id=target_room
  ORDER BY a.sequence_number DESC LIMIT 1;
  new_sequence:=coalesce(previous_sequence,0)+1;
  previous_hash:=coalesce(previous_hash,repeat('0',64));

  data_hash:=pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'version',1,'id',target_id,'room',target_room,'actor',target_actor,
      'action',target_action,'hidden_at',hidden_stamp
    )::text,'UTF8')),'hex');
  event_stamp:=pg_catalog.clock_timestamp();
  event_hash_value:=pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'version',1,'room',target_room,'sequence',new_sequence,
      'actor',target_actor,'kind',target_action,'note',target_id,
      'payload_hash',data_hash,'previous_hash',previous_hash,
      'occurred_at',event_stamp
    )::text,'UTF8')),'hex');
  INSERT INTO public.reading_audit_v2(
    room_id,sequence_number,actor_id,action,note_id,payload_hash,
    previous_hash,event_hash,occurred_at
  ) VALUES(target_room,new_sequence,target_actor,target_action,target_id,
    data_hash,previous_hash,event_hash_value,event_stamp);
END;
$$;

-- Returns FALSE instead of leaking whether an unavailable ID exists.
-- A user can hide only their own record while the room remains active.
CREATE FUNCTION public.v2_hide_ink(target_room uuid, target_ink uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  actor uuid:=auth.uid();
  stamp timestamptz;
BEGIN
  IF actor IS NULL OR target_room IS NULL OR target_ink IS NULL OR
     NOT public.v2_can_edit_room(target_room) THEN
    RETURN false;
  END IF;
  UPDATE public.reading_ink_v2 SET
    hidden_at=pg_catalog.clock_timestamp(),hidden_by=actor
  WHERE id=target_ink AND room_id=target_room AND author_id=actor
    AND hidden_at IS NULL
  RETURNING hidden_at INTO stamp;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM public.v2_append_hide_audit(
    target_room,target_ink,actor,'ink.hidden',stamp);
  RETURN true;
END;
$$;

CREATE FUNCTION public.v2_hide_reply(target_room uuid, target_reply uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  actor uuid:=auth.uid();
  stamp timestamptz;
BEGIN
  IF actor IS NULL OR target_room IS NULL OR target_reply IS NULL OR
     NOT public.v2_can_edit_room(target_room) THEN
    RETURN false;
  END IF;
  UPDATE public.reading_note_replies_v2 SET
    hidden_at=pg_catalog.clock_timestamp(),hidden_by=actor
  WHERE id=target_reply AND room_id=target_room AND author_id=actor
    AND hidden_at IS NULL
  RETURNING hidden_at INTO stamp;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM public.v2_append_hide_audit(
    target_room,target_reply,actor,'reply.hidden',stamp);
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.v2_append_hide_audit(
  uuid,uuid,uuid,text,timestamptz) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.v2_hide_ink(uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.v2_hide_reply(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.v2_hide_ink(uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.v2_hide_reply(uuid,uuid) TO authenticated;
