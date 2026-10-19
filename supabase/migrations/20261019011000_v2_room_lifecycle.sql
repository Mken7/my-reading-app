-- Module 03: explicit code revocation and applicant withdrawal.
-- Apply only to V2 disposable staging after the previous isolated migrations.
-- A canceled applicant is NOT a member and cannot bypass owner approval.
ALTER TABLE public.reading_join_requests_v2
  DROP CONSTRAINT reading_join_requests_v2_status_check;
ALTER TABLE public.reading_join_requests_v2
  ADD CONSTRAINT reading_join_requests_v2_status_check
  CHECK (status IN ('pending','approved','rejected','cancelled'));

-- One room row lock serializes revocation with invite rotation and approval.
-- Only the owner of an active room can revoke an unredeemed code.
CREATE FUNCTION public.v2_revoke_room_invite(target_room uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $$
DECLARE actor uuid:=auth.uid();
  room_owner uuid;
  room_state text;
  revoked integer;
BEGIN
  IF actor IS NULL OR target_room IS NULL THEN RETURN false; END IF;
  SELECT r.owner_id,r.state INTO room_owner,room_state
  FROM public.reading_rooms_v2 r
  WHERE r.id=target_room FOR UPDATE;
  IF room_owner IS DISTINCT FROM actor OR room_state IS DISTINCT FROM 'active'
    OR NOT public.v2_is_room_member(target_room) THEN RETURN false; END IF;
  UPDATE public.reading_invitations_v2 i
  SET status='revoked'
  WHERE i.room_id=target_room AND i.status='open';
  GET DIAGNOSTICS revoked=ROW_COUNT;
  IF revoked=0 THEN RETURN false; END IF;
  UPDATE public.reading_join_requests_v2 q
  SET status='rejected',reviewed_at=pg_catalog.now()
  WHERE q.room_id=target_room AND q.status='pending';
  RETURN true;
END;
$$;

-- Applicants can undo a pending request before its owner accepts it.
-- If approval won the room row lock, withdrawal fails and never erases
-- an already granted membership or silently evicts a partner.
CREATE FUNCTION public.v2_withdraw_room_join(target_room uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $$
DECLARE actor uuid:=auth.uid();
  matched_id uuid;
BEGIN
  IF actor IS NULL OR target_room IS NULL THEN RETURN false; END IF;
  PERFORM 1 FROM public.reading_rooms_v2 r
  WHERE r.id=target_room FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE public.reading_join_requests_v2 q
  SET status='cancelled',reviewed_at=pg_catalog.now()
  WHERE q.room_id=target_room AND q.requester_id=actor
    AND q.status='pending'
  RETURNING q.id INTO matched_id;
  RETURN matched_id IS NOT NULL;
END;
$$;

-- Room roster: only two active seats, no emails or auth metadata. Empty
-- result for outsiders and closed rooms; no third-party room discovery.
CREATE FUNCTION public.v2_room_roster(target_room uuid)
RETURNS TABLE(user_id uuid,role text,joined_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$
  SELECT m.user_id,m.role,m.joined_at
  FROM public.reading_members_v2 m
  WHERE m.room_id=target_room AND m.left_at IS NULL
    AND public.v2_can_edit_room(target_room)
  ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END,m.joined_at
  LIMIT 2;
$$;

-- Isolate applicants' request tracking from room owners' moderation view.
-- Never expose invitation IDs, code hashes, secrets, room title, or emails.
CREATE FUNCTION public.v2_my_join_requests()
RETURNS TABLE(room_id uuid,status text,requested_at timestamptz,reviewed_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$
  SELECT q.room_id,q.status,q.requested_at,q.reviewed_at
  FROM public.reading_join_requests_v2 q
  WHERE auth.uid() IS NOT NULL AND q.requester_id=auth.uid()
  ORDER BY q.requested_at DESC
  LIMIT 20;
$$;

REVOKE ALL ON FUNCTION public.v2_revoke_room_invite(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.v2_withdraw_room_join(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.v2_room_roster(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.v2_my_join_requests() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.v2_revoke_room_invite(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.v2_withdraw_room_join(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.v2_room_roster(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.v2_my_join_requests() TO authenticated;
