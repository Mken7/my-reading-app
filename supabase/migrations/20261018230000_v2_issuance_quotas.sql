-- V2 per-account issuance quotas. No legacy table changes.
-- SECURITY NOTE: These quotas are not a complete bot defense: distributed
-- account farms still require protected signup and network-aware gateway limits.
--
-- Room limit: 3 successful creations per rolling 24-hour window.
-- Invitation limit: 10 successful issuances per rolling 24-hour window.
-- All counters are updated atomically inside the trusted RPC transaction.

CREATE TABLE public.reading_issuance_quotas_v2 (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id),
  room_window timestamptz NOT NULL DEFAULT now(),
  room_issued integer NOT NULL DEFAULT 0 CHECK (room_issued >= 0),
  invite_window timestamptz NOT NULL DEFAULT now(),
  invite_issued integer NOT NULL DEFAULT 0 CHECK (invite_issued >= 0)
);
ALTER TABLE public.reading_issuance_quotas_v2 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reading_issuance_quotas_v2 FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.v2_enforce_room_issuance_quota()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  quota_count integer;
BEGIN
  INSERT INTO public.reading_issuance_quotas_v2 (
    user_id,room_window,room_issued,invite_window,invite_issued
  ) VALUES (NEW.owner_id,now(),1,now(),0)
  ON CONFLICT(user_id) DO UPDATE SET
    room_window = CASE
      WHEN public.reading_issuance_quotas_v2.room_window < now()-interval '24 hours'
      THEN now() ELSE public.reading_issuance_quotas_v2.room_window END,
    room_issued = CASE
      WHEN public.reading_issuance_quotas_v2.room_window < now()-interval '24 hours'
      THEN 1 ELSE public.reading_issuance_quotas_v2.room_issued+1 END
  RETURNING room_issued INTO quota_count;

  IF quota_count > 3 THEN
    RAISE EXCEPTION 'Daily room creation quota exceeded' USING ERRCODE='P0011';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reading_rooms_v2_quota
BEFORE INSERT ON public.reading_rooms_v2
FOR EACH ROW EXECUTE FUNCTION public.v2_enforce_room_issuance_quota();

CREATE FUNCTION public.v2_enforce_invite_issuance_quota()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  quota_count integer;
BEGIN
  INSERT INTO public.reading_issuance_quotas_v2 (
    user_id,room_window,room_issued,invite_window,invite_issued
  ) VALUES (NEW.created_by,now(),0,now(),1)
  ON CONFLICT(user_id) DO UPDATE SET
    invite_window = CASE
      WHEN public.reading_issuance_quotas_v2.invite_window < now()-interval '24 hours'
      THEN now() ELSE public.reading_issuance_quotas_v2.invite_window END,
    invite_issued = CASE
      WHEN public.reading_issuance_quotas_v2.invite_window < now()-interval '24 hours'
      THEN 1 ELSE public.reading_issuance_quotas_v2.invite_issued+1 END
  RETURNING invite_issued INTO quota_count;

  IF quota_count > 10 THEN
    RAISE EXCEPTION 'Daily invitation issuance quota exceeded' USING ERRCODE='P0010';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reading_invitations_v2_quota
BEFORE INSERT ON public.reading_invitations_v2
FOR EACH ROW EXECUTE FUNCTION public.v2_enforce_invite_issuance_quota();

REVOKE ALL ON FUNCTION public.v2_enforce_room_issuance_quota()
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.v2_enforce_invite_issuance_quota()
  FROM PUBLIC,anon,authenticated;
