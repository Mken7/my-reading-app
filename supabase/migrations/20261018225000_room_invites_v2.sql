-- V2 invitation RPCs, isolated from legacy tables. DO NOT apply to production yet.
-- Six-character base32 code: 30 bits entropy, only suitable for rate-limited
-- online lookup. No raw invitation codes are persisted; codes are shown once.
-- The server must also enforce signup, IP/device and abuse controls.
-- All membership changes require an owner's explicit approval.

CREATE TABLE public.reading_invite_secret_v2 (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  pepper bytea NOT NULL CHECK (octet_length(pepper) = 32)
);
INSERT INTO public.reading_invite_secret_v2(singleton,pepper)
VALUES (true, sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text,'UTF8')));

CREATE TABLE public.reading_invitations_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES public.reading_rooms_v2(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  code_hash bytea NOT NULL UNIQUE CHECK (octet_length(code_hash) = 32),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','redeemed','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  redeemed_by uuid REFERENCES auth.users(id),
  CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX reading_invitations_v2_one_open_per_room
  ON public.reading_invitations_v2(room_id) WHERE status = 'open';

CREATE TABLE public.reading_join_attempts_v2 (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id),
  window_start timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);

CREATE TABLE public.reading_join_requests_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES public.reading_rooms_v2(id) ON DELETE CASCADE,
  requester_id uuid NOT NULL REFERENCES auth.users(id),
  invitation_id uuid NOT NULL REFERENCES public.reading_invitations_v2(id),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  UNIQUE(room_id,requester_id)
);
CREATE INDEX reading_join_requests_v2_room_status
  ON public.reading_join_requests_v2(room_id,status,requested_at);

ALTER TABLE public.reading_invite_secret_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reading_invitations_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reading_join_attempts_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reading_join_requests_v2 ENABLE ROW LEVEL SECURITY;

-- Do not expose hashes, secrets, attempt counters, or invitation rows through
-- client table APIs. Owners may view join requests, not their code hashes.
REVOKE ALL ON public.reading_invite_secret_v2 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON public.reading_invitations_v2 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON public.reading_join_attempts_v2 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON public.reading_join_requests_v2 FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.reading_join_requests_v2 TO authenticated;

CREATE POLICY reading_join_requests_v2_read
ON public.reading_join_requests_v2 FOR SELECT TO authenticated
USING (
  requester_id = (SELECT auth.uid())
  OR EXISTS (
    SELECT 1 FROM public.reading_rooms_v2 r
    WHERE r.id = room_id AND r.owner_id = (SELECT auth.uid())
  )
);

CREATE FUNCTION public.v2_create_room_invite(target_room uuid)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor uuid := auth.uid();
  owner uuid;
  room_state text;
  secret bytea;
  seed bytea;
  invite_code text;
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  digest bytea;
  counter integer;
  idx integer;
  new_invite_id uuid;
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  SELECT r.owner_id,r.state INTO owner,room_state
  FROM public.reading_rooms_v2 r
  WHERE r.id=target_room
  FOR UPDATE;
  IF owner IS DISTINCT FROM actor OR room_state <> 'active' THEN
    RAISE EXCEPTION 'Not permitted to create this invitation' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.reading_members_v2 m
    WHERE m.room_id=target_room AND m.role='partner'
  ) THEN
    RAISE EXCEPTION 'The partner seat is already allocated' USING ERRCODE='23514';
  END IF;
  SELECT pepper INTO secret
  FROM public.reading_invite_secret_v2 WHERE singleton=true;
  UPDATE public.reading_invitations_v2
    SET status='revoked'
    WHERE room_id=target_room AND status='open';
  UPDATE public.reading_join_requests_v2
    SET status='rejected',reviewed_at=now()
    WHERE room_id=target_room AND status='pending';

  FOR counter IN 1..12 LOOP
    seed := sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text,'UTF8'));
    invite_code := '';
    FOR idx IN 0..5 LOOP
      invite_code := invite_code || substr(alphabet,(get_byte(seed,idx) % 32)+1,1);
    END LOOP;
    digest := sha256(secret || convert_to(invite_code,'UTF8'));
    INSERT INTO public.reading_invitations_v2
      (room_id,created_by,code_hash,expires_at)
    VALUES(target_room,actor,digest,now()+interval '24 hours')
    ON CONFLICT (code_hash) DO NOTHING
    RETURNING id INTO new_invite_id;

    IF new_invite_id IS NOT NULL THEN
      RETURN invite_code;
    END IF;
  END LOOP;
  RAISE EXCEPTION 'Unable to create a unique code; retry later';
END;
$$;

CREATE FUNCTION public.v2_request_room_join(invite_code text)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor uuid := auth.uid();
  normalized text := upper(btrim(invite_code));
  attempt_count integer;
  secret bytea;
  room uuid;
  invitation uuid;
  owner uuid;
  room_state text;
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000';
  END IF;
  -- This counter is committed even for bad codes; do not raise an exception on
  -- failed lookup because it would roll back the rate-limit increment.
  INSERT INTO public.reading_join_attempts_v2(user_id,window_start,attempts)
  VALUES(actor,now(),1)
  ON CONFLICT (user_id) DO UPDATE
    SET window_start = CASE
          WHEN public.reading_join_attempts_v2.window_start < now()-interval '1 hour'
          THEN now() ELSE public.reading_join_attempts_v2.window_start END,
        attempts = CASE
          WHEN public.reading_join_attempts_v2.window_start < now()-interval '1 hour'
          THEN 1 ELSE public.reading_join_attempts_v2.attempts + 1 END
  RETURNING attempts INTO attempt_count;

  IF attempt_count > 5 THEN
    RETURN 'rate_limited';
  END IF;
  IF normalized IS NULL OR normalized !~ '^[A-HJ-NP-Z2-9]{6}$' THEN
    RETURN 'invalid_or_expired';
  END IF;

  SELECT pepper INTO secret
  FROM public.reading_invite_secret_v2 WHERE singleton=true;
  SELECT i.room_id,i.id INTO room,invitation
  FROM public.reading_invitations_v2 i
  WHERE i.code_hash=sha256(secret || convert_to(normalized,'UTF8'))
    AND i.status='open' AND i.expires_at > now();
  IF room IS NULL THEN
    RETURN 'invalid_or_expired';
  END IF;

  SELECT r.owner_id,r.state INTO owner,room_state
  FROM public.reading_rooms_v2 r WHERE r.id=room;
  IF room_state IS DISTINCT FROM 'active'
     OR actor=owner
     OR EXISTS(SELECT 1 FROM public.reading_members_v2 m WHERE m.room_id=room)
         AND (SELECT count(*) FROM public.reading_members_v2 m
              WHERE m.room_id=room) >= 2 THEN
    RETURN 'invalid_or_expired';
  END IF;
  IF EXISTS(SELECT 1 FROM public.reading_members_v2 m
            WHERE m.room_id=room AND m.user_id=actor) THEN
    RETURN 'invalid_or_expired';
  END IF;

  INSERT INTO public.reading_join_requests_v2
    (room_id,requester_id,invitation_id,status,requested_at,reviewed_at)
  VALUES(room,actor,invitation,'pending',now(),NULL)
  ON CONFLICT (room_id,requester_id) DO UPDATE SET
    invitation_id=EXCLUDED.invitation_id,
    status='pending',requested_at=now(),reviewed_at=NULL
  WHERE public.reading_join_requests_v2.status <> 'approved';
  RETURN 'submitted';
END;
$$;

CREATE FUNCTION public.v2_review_room_join(
  target_room uuid, requester uuid, approve boolean
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor uuid := auth.uid();
  owner uuid;
  room_state text;
  invitation uuid;
  invite_status text;
  expires timestamptz;
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000';
  END IF;

  -- Lock serializes owner decisions, concurrent invite rotation, and all
  -- approvals within a room. Membership role uniqueness is a second backstop.
  SELECT r.owner_id,r.state INTO owner,room_state
  FROM public.reading_rooms_v2 r WHERE r.id=target_room FOR UPDATE;
  IF owner IS DISTINCT FROM actor OR room_state IS DISTINCT FROM 'active' THEN
    RETURN false;
  END IF;
  SELECT q.invitation_id INTO invitation
  FROM public.reading_join_requests_v2 q
  WHERE q.room_id=target_room AND q.requester_id=requester
    AND q.status='pending'
  FOR UPDATE;
  IF invitation IS NULL THEN
    RETURN false;
  END IF;

  IF NOT approve THEN
    UPDATE public.reading_join_requests_v2
    SET status='rejected',reviewed_at=now()
    WHERE room_id=target_room AND requester_id=requester;
    RETURN true;
  END IF;

  SELECT i.status,i.expires_at INTO invite_status,expires
  FROM public.reading_invitations_v2 i
  WHERE i.id=invitation AND i.room_id=target_room
  FOR UPDATE;
  IF invite_status IS DISTINCT FROM 'open' OR expires <= now()
     OR EXISTS(SELECT 1 FROM public.reading_members_v2 m
               WHERE m.room_id=target_room AND m.role='partner') THEN
    RETURN false;
  END IF;

  INSERT INTO public.reading_members_v2(room_id,user_id,role)
  VALUES(target_room,requester,'partner');

  UPDATE public.reading_join_requests_v2
  SET status='approved',reviewed_at=now()
  WHERE room_id=target_room AND requester_id=requester;
  UPDATE public.reading_join_requests_v2
  SET status='rejected',reviewed_at=now()
  WHERE room_id=target_room AND status='pending';
  UPDATE public.reading_invitations_v2
  SET status='redeemed',redeemed_by=requester
  WHERE id=invitation;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.v2_create_room_invite(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.v2_request_room_join(text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.v2_review_room_join(uuid,uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.v2_create_room_invite(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.v2_request_room_join(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.v2_review_room_join(uuid,uuid,boolean) TO authenticated;
