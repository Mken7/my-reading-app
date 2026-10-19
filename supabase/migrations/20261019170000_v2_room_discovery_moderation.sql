-- Module 11: explicitly opted-in, metadata-only reading room discovery;
-- owner-moderated applications, report intake, two-way blocks.
-- STAGING ONLY after 20261019160000_v2_spoiler_gate_realtime.sql.
-- No private book titles, chapter titles, text, notes, invite codes or email
-- are exposed through discovery. Prior rooms default to unlisted.

CREATE TABLE public.reading_directory_v2(
 room_id uuid PRIMARY KEY REFERENCES public.reading_rooms_v2(id) ON DELETE CASCADE,
 public_title text NOT NULL CHECK (char_length(btrim(public_title)) BETWEEN 1 AND 80),
 public_about text NOT NULL DEFAULT '' CHECK (char_length(public_about)<=240),
 listed boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.reading_discovery_requests_v2(
 room_id uuid NOT NULL REFERENCES public.reading_rooms_v2(id) ON DELETE CASCADE,
 requester_id uuid NOT NULL REFERENCES auth.users(id),
 status text NOT NULL DEFAULT 'pending'
    CHECK(status IN('pending','approved','rejected','withdrawn')),
 requested_at timestamptz NOT NULL DEFAULT now(),
 reviewed_at timestamptz,
 PRIMARY KEY(room_id,requester_id)
);
CREATE INDEX reading_discovery_requests_v2_inbox
 ON public.reading_discovery_requests_v2(room_id,status,requested_at);
CREATE TABLE public.reading_discovery_attempts_v2(
 user_id uuid PRIMARY KEY REFERENCES auth.users(id),
 window_start timestamptz NOT NULL DEFAULT now(),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0)
);
CREATE TABLE public.reading_discovery_blocks_v2(
 blocker_id uuid NOT NULL REFERENCES auth.users(id),
 blocked_id uuid NOT NULL REFERENCES auth.users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(blocker_id,blocked_id),
 CHECK(blocker_id<>blocked_id)
);
CREATE TABLE public.reading_discovery_reports_v2(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 room_id uuid NOT NULL REFERENCES public.reading_rooms_v2(id),
 reporter_id uuid NOT NULL REFERENCES auth.users(id),
 reason text NOT NULL CHECK(reason IN('harassment','spam','privacy','copyright','other')),
 details text NOT NULL CHECK(char_length(btrim(details)) BETWEEN 10 AND 500),
 created_at timestamptz NOT NULL DEFAULT now(),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','reviewed','closed'))
);
CREATE INDEX reading_discovery_reports_v2_moderation
 ON public.reading_discovery_reports_v2(status,created_at);
CREATE TABLE public.reading_discovery_report_attempts_v2(
 user_id uuid PRIMARY KEY REFERENCES auth.users(id),
 window_start timestamptz NOT NULL DEFAULT now(),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0)
);
DO $$
DECLARE relation text;
BEGIN
 FOREACH relation IN ARRAY ARRAY[
  'reading_directory_v2','reading_discovery_requests_v2',
  'reading_discovery_attempts_v2','reading_discovery_blocks_v2',
  'reading_discovery_reports_v2','reading_discovery_report_attempts_v2'
 ] LOOP
  EXECUTE pg_catalog.format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE pg_catalog.format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',relation);
 END LOOP;
END $$;

-- Pairwise blocks apply regardless of which account initiated them.
-- This is used for directory, discovery approvals and legacy invite joins.
CREATE FUNCTION public.v2_is_discovery_blocked(person_a uuid,person_b uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$
 SELECT person_a IS NOT NULL AND person_b IS NOT NULL AND EXISTS(
  SELECT 1 FROM public.reading_discovery_blocks_v2 b
  WHERE (b.blocker_id=person_a AND b.blocked_id=person_b)
     OR (b.blocker_id=person_b AND b.blocked_id=person_a)
 );
$$;

CREATE FUNCTION public.v2_set_room_listing(
 target_room uuid,title text,about text,enabled boolean
) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $$
DECLARE actor uuid:=auth.uid(); owner uuid; room_state text;
BEGIN
 IF actor IS NULL OR target_room IS NULL OR enabled IS NULL THEN RETURN false; END IF;
 SELECT owner_id,state INTO owner,room_state FROM public.reading_rooms_v2
 WHERE id=target_room FOR UPDATE;
 IF owner IS DISTINCT FROM actor OR room_state IS DISTINCT FROM 'active'
   OR NOT public.v2_is_room_member(target_room) THEN RETURN false; END IF;
 IF enabled AND (title IS NULL OR char_length(btrim(title)) NOT BETWEEN 1 AND 80
   OR about IS NULL OR char_length(about)>240 OR
   EXISTS(SELECT 1 FROM public.reading_members_v2 m
     WHERE m.room_id=target_room AND m.role='partner' AND m.left_at IS NULL))
 THEN RETURN false; END IF;
 IF NOT enabled THEN
   UPDATE public.reading_directory_v2 SET listed=false,updated_at=now()
    WHERE room_id=target_room;
   UPDATE public.reading_discovery_requests_v2 SET status='rejected',reviewed_at=now()
    WHERE room_id=target_room AND status='pending';
   RETURN true;
 END IF;
 INSERT INTO public.reading_directory_v2(room_id,public_title,public_about,listed)
 VALUES(target_room,btrim(title),btrim(about),true)
 ON CONFLICT(room_id) DO UPDATE SET
 public_title=EXCLUDED.public_title,public_about=EXCLUDED.public_about,
 listed=true,updated_at=now();
 RETURN true;
END $$;

CREATE FUNCTION public.v2_my_room_listings()
RETURNS TABLE(room_id uuid,public_title text,public_about text,listed boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$
 SELECT d.room_id,d.public_title,d.public_about,d.listed
 FROM public.reading_directory_v2 d
 JOIN public.reading_rooms_v2 r ON r.id=d.room_id
 WHERE r.owner_id=auth.uid() AND r.state='active'
 AND public.v2_is_room_member(r.id)
 ORDER BY d.updated_at DESC LIMIT 100;
$$;

-- Bounded, opt-in-only directory; no owner id or real room title.
CREATE FUNCTION public.v2_discover_reading_rooms(query_text text DEFAULT '',page_limit integer DEFAULT 12)
RETURNS TABLE(room_id uuid,public_title text,public_about text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$
 SELECT d.room_id,d.public_title,d.public_about
 FROM public.reading_directory_v2 d
 JOIN public.reading_rooms_v2 r ON r.id=d.room_id
 WHERE auth.uid() IS NOT NULL AND r.state='active' AND d.listed
  AND r.owner_id<>auth.uid() AND public.v2_is_room_member(d.room_id) = false
  AND NOT public.v2_is_discovery_blocked(auth.uid(),r.owner_id)
  AND NOT EXISTS(SELECT 1 FROM public.reading_members_v2 m
      WHERE m.room_id=d.room_id AND m.role='partner' AND m.left_at IS NULL)
  AND (coalesce(char_length(query_text),0)=0 OR
      (char_length(query_text)<=64 AND
       (strpos(lower(d.public_title),lower(btrim(query_text)))>0 OR
        strpos(lower(d.public_about),lower(btrim(query_text)))>0)))
 ORDER BY d.updated_at DESC,d.room_id
 LIMIT least(greatest(coalesce(page_limit,12),1),20);
$$;

-- A persisted attempt counter (even for invalid identifiers) prevents easy
-- room UUID enumeration and request bursts. Generic outcomes for missing rooms.
CREATE FUNCTION public.v2_request_discovered_room(target_room uuid)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $$
DECLARE actor uuid:=auth.uid(); tries integer; owner uuid; room_state text;
  prior_status text;
BEGIN
 IF actor IS NULL THEN RETURN 'unavailable'; END IF;
 INSERT INTO public.reading_discovery_attempts_v2(user_id,window_start,attempts)
 VALUES(actor,now(),1)
 ON CONFLICT(user_id) DO UPDATE SET
  window_start=CASE WHEN public.reading_discovery_attempts_v2.window_start<now()-interval '1 day'
   THEN now() ELSE public.reading_discovery_attempts_v2.window_start END,
  attempts=CASE WHEN public.reading_discovery_attempts_v2.window_start<now()-interval '1 day'
   THEN 1 ELSE public.reading_discovery_attempts_v2.attempts+1 END
 RETURNING attempts INTO tries;
 IF tries>5 THEN RETURN 'rate_limited'; END IF;
 IF target_room IS NULL THEN RETURN 'unavailable'; END IF;
 SELECT r.owner_id,r.state INTO owner,room_state FROM public.reading_rooms_v2 r
 WHERE id=target_room FOR UPDATE;
 IF owner IS NULL OR owner=actor OR room_state IS DISTINCT FROM 'active'
 OR public.v2_is_discovery_blocked(actor,owner)
 OR NOT EXISTS(SELECT 1 FROM public.reading_directory_v2 d
   WHERE d.room_id=target_room AND d.listed)
 OR EXISTS(SELECT 1 FROM public.reading_members_v2 m WHERE m.room_id=target_room
   AND (m.user_id=actor OR (m.role='partner' AND m.left_at IS NULL)))
 THEN RETURN 'unavailable'; END IF;
 SELECT q.status INTO prior_status FROM public.reading_discovery_requests_v2 q
 WHERE q.room_id=target_room AND q.requester_id=actor;
 IF prior_status='pending' THEN RETURN 'already_requested'; END IF;
 IF prior_status='approved' THEN RETURN 'unavailable'; END IF;
 INSERT INTO public.reading_discovery_requests_v2(room_id,requester_id)
 VALUES(target_room,actor)
 ON CONFLICT(room_id,requester_id) DO UPDATE SET
 status='pending',requested_at=now(),reviewed_at=NULL;
 RETURN 'submitted';
END $$;

CREATE FUNCTION public.v2_my_discovery_requests()
RETURNS TABLE(room_id uuid,status text,requested_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$
 SELECT q.room_id,q.status,q.requested_at
 FROM public.reading_discovery_requests_v2 q
 WHERE q.requester_id=auth.uid()
 ORDER BY q.requested_at DESC LIMIT 30;
$$;
CREATE FUNCTION public.v2_discovery_inbox()
RETURNS TABLE(room_id uuid,requester_id uuid,requested_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$
 SELECT q.room_id,q.requester_id,q.requested_at
 FROM public.reading_discovery_requests_v2 q
 JOIN public.reading_rooms_v2 r ON r.id=q.room_id
 WHERE r.owner_id=auth.uid() AND r.state='active'
   AND q.status='pending' AND public.v2_is_room_member(r.id)
   AND NOT public.v2_is_discovery_blocked(r.owner_id,q.requester_id)
 ORDER BY q.requested_at LIMIT 50;
$$;

CREATE FUNCTION public.v2_withdraw_discovery_request(target_room uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $$
DECLARE count_changed integer;
BEGIN
 IF auth.uid() IS NULL OR target_room IS NULL THEN RETURN false; END IF;
 UPDATE public.reading_discovery_requests_v2 SET status='withdrawn',reviewed_at=now()
 WHERE room_id=target_room AND requester_id=auth.uid() AND status='pending';
 GET DIAGNOSTICS count_changed=ROW_COUNT;
 RETURN count_changed=1;
END $$;

-- Single room lock serializes approval with listing shutdown/invite approval.
-- Owner explicitly approves; a discovered listing does NOT grant membership.
CREATE FUNCTION public.v2_review_discovery_request(target_room uuid,requester uuid,approve boolean)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $$
DECLARE actor uuid:=auth.uid(); room_owner uuid; state text;
BEGIN
 IF actor IS NULL OR requester IS NULL OR target_room IS NULL OR approve IS NULL THEN
   RETURN false; END IF;
 SELECT owner_id,r.state INTO room_owner,state FROM public.reading_rooms_v2 r
 WHERE r.id=target_room FOR UPDATE;
 IF room_owner IS DISTINCT FROM actor OR state IS DISTINCT FROM 'active'
 OR NOT public.v2_is_room_member(target_room)
 OR public.v2_is_discovery_blocked(actor,requester)
 OR NOT EXISTS(SELECT 1 FROM public.reading_discovery_requests_v2 q
    WHERE q.room_id=target_room AND q.requester_id=requester AND q.status='pending')
 THEN RETURN false; END IF;
 IF NOT approve THEN
  UPDATE public.reading_discovery_requests_v2
  SET status='rejected',reviewed_at=now()
  WHERE room_id=target_room AND requester_id=requester AND status='pending';
  RETURN true;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.reading_directory_v2 d
     WHERE d.room_id=target_room AND d.listed)
 OR EXISTS(SELECT 1 FROM public.reading_members_v2 m
     WHERE m.room_id=target_room AND m.role='partner')
 OR requester=actor
 THEN RETURN false; END IF;
 INSERT INTO public.reading_members_v2(room_id,user_id,role)
 VALUES(target_room,requester,'partner');
 UPDATE public.reading_discovery_requests_v2 SET status='approved',reviewed_at=now()
 WHERE room_id=target_room AND requester_id=requester;
 UPDATE public.reading_discovery_requests_v2 SET status='rejected',reviewed_at=now()
 WHERE room_id=target_room AND status='pending';
 UPDATE public.reading_directory_v2 SET listed=false,updated_at=now()
 WHERE room_id=target_room;
 UPDATE public.reading_invitations_v2 SET status='revoked'
 WHERE room_id=target_room AND status='open';
 UPDATE public.reading_join_requests_v2 SET status='rejected',reviewed_at=now()
 WHERE room_id=target_room AND status='pending';
 RETURN true;
END $$;

-- A block requires prior discovery visibility/interaction or an actual
-- applicant; it is never a free-form UUID enumeration endpoint.
CREATE FUNCTION public.v2_block_discovery_room(target_room uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $$
DECLARE actor uuid:=auth.uid(); room_owner uuid;
BEGIN
 IF actor IS NULL OR target_room IS NULL THEN RETURN false; END IF;
 SELECT r.owner_id INTO room_owner FROM public.reading_rooms_v2 r
 WHERE r.id=target_room AND (
   EXISTS(SELECT 1 FROM public.reading_directory_v2 d
    WHERE d.room_id=r.id AND d.listed AND r.state='active')
   OR EXISTS(SELECT 1 FROM public.reading_discovery_requests_v2 q
    WHERE q.room_id=r.id AND q.requester_id=actor)
   OR EXISTS(SELECT 1 FROM public.reading_members_v2 m
    WHERE m.room_id=r.id AND m.user_id=actor));
 IF room_owner IS NULL OR room_owner=actor THEN RETURN false; END IF;
 INSERT INTO public.reading_discovery_blocks_v2(blocker_id,blocked_id)
 VALUES(actor,room_owner) ON CONFLICT DO NOTHING;
 UPDATE public.reading_discovery_requests_v2 SET status='withdrawn',reviewed_at=now()
 WHERE room_id=target_room AND requester_id=actor AND status='pending';
 RETURN true;
END $$;
CREATE FUNCTION public.v2_block_discovery_applicant(target_room uuid,requester uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $$
DECLARE actor uuid:=auth.uid(); room_owner uuid;
BEGIN
 IF actor IS NULL OR requester IS NULL OR requester=actor OR target_room IS NULL THEN
   RETURN false; END IF;
 SELECT owner_id INTO room_owner FROM public.reading_rooms_v2 WHERE id=target_room FOR UPDATE;
 IF room_owner IS DISTINCT FROM actor OR NOT EXISTS(
   SELECT 1 FROM public.reading_discovery_requests_v2 q
   WHERE q.room_id=target_room AND q.requester_id=requester
 ) THEN RETURN false; END IF;
 INSERT INTO public.reading_discovery_blocks_v2(blocker_id,blocked_id)
 VALUES(actor,requester) ON CONFLICT DO NOTHING;
 UPDATE public.reading_discovery_requests_v2 SET status='rejected',reviewed_at=now()
 WHERE room_id=target_room AND requester_id=requester AND status='pending';
 RETURN true;
END $$;
CREATE FUNCTION public.v2_my_discovery_blocks()
RETURNS TABLE(blocked_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$
 SELECT b.blocked_id FROM public.reading_discovery_blocks_v2 b
 WHERE b.blocker_id=auth.uid() ORDER BY b.created_at DESC LIMIT 100;
$$;
CREATE FUNCTION public.v2_unblock_discovery_user(target_user uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $$
DECLARE count_changed integer;
BEGIN
 IF auth.uid() IS NULL OR target_user IS NULL THEN RETURN false; END IF;
 DELETE FROM public.reading_discovery_blocks_v2
 WHERE blocker_id=auth.uid() AND blocked_id=target_user;
 GET DIAGNOSTICS count_changed=ROW_COUNT;
 RETURN count_changed=1;
END $$;

-- Blocks also gate legacy invite-code submissions/approvals: no bypass via
-- a guessed six-character code. They do not silently evict existing readers.
CREATE FUNCTION public.v2_guard_blocked_join()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE room_owner uuid;
BEGIN
 SELECT owner_id INTO room_owner FROM public.reading_rooms_v2 WHERE id=NEW.room_id;
 IF public.v2_is_discovery_blocked(room_owner,NEW.requester_id)
   AND NEW.status='pending' THEN
  RAISE EXCEPTION 'Membership request unavailable' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reading_join_requests_v2_block_gate
BEFORE INSERT OR UPDATE ON public.reading_join_requests_v2
FOR EACH ROW EXECUTE FUNCTION public.v2_guard_blocked_join();
CREATE FUNCTION public.v2_guard_blocked_membership()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE room_owner uuid;
BEGIN
 IF NEW.role='partner' THEN
  SELECT owner_id INTO room_owner FROM public.reading_rooms_v2 WHERE id=NEW.room_id;
  IF public.v2_is_discovery_blocked(room_owner,NEW.user_id) THEN
   RAISE EXCEPTION 'Membership approval unavailable' USING ERRCODE='42501';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reading_members_v2_block_gate
BEFORE INSERT ON public.reading_members_v2
FOR EACH ROW EXECUTE FUNCTION public.v2_guard_blocked_membership();

-- Reports are private moderator intake, never visible to the subject.
-- Rate limit is recorded transactionally, even for nonexistent rooms.
CREATE FUNCTION public.v2_report_discovery_room(target_room uuid,category text,note text)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $$
DECLARE actor uuid:=auth.uid(); room_owner uuid; tries integer;
BEGIN
 IF actor IS NULL THEN RETURN 'unavailable'; END IF;
 INSERT INTO public.reading_discovery_report_attempts_v2(user_id,window_start,attempts)
 VALUES(actor,now(),1)
 ON CONFLICT(user_id) DO UPDATE SET
  window_start=CASE WHEN public.reading_discovery_report_attempts_v2.window_start<now()-interval '1 day'
   THEN now() ELSE public.reading_discovery_report_attempts_v2.window_start END,
  attempts=CASE WHEN public.reading_discovery_report_attempts_v2.window_start<now()-interval '1 day'
   THEN 1 ELSE public.reading_discovery_report_attempts_v2.attempts+1 END
 RETURNING attempts INTO tries;
 IF tries>5 THEN RETURN 'rate_limited'; END IF;
 IF target_room IS NULL OR category NOT IN('harassment','spam','privacy','copyright','other')
 OR note IS NULL OR char_length(btrim(note)) NOT BETWEEN 10 AND 500 THEN
 RETURN 'unavailable'; END IF;
 SELECT owner_id INTO room_owner FROM public.reading_rooms_v2
 WHERE id=target_room AND (
   EXISTS(SELECT 1 FROM public.reading_directory_v2 d WHERE d.room_id=target_room)
   OR EXISTS(SELECT 1 FROM public.reading_discovery_requests_v2 q
    WHERE q.room_id=target_room AND q.requester_id=actor));
 IF room_owner IS NULL OR room_owner=actor THEN RETURN 'unavailable'; END IF;
 INSERT INTO public.reading_discovery_reports_v2(room_id,reporter_id,reason,details)
 VALUES(target_room,actor,category,btrim(note));
 RETURN 'submitted';
END $$;

DO $$
DECLARE fn text;
BEGIN
 FOREACH fn IN ARRAY ARRAY[
  'v2_is_discovery_blocked(uuid,uuid)',
  'v2_set_room_listing(uuid,text,text,boolean)',
  'v2_my_room_listings()','v2_discover_reading_rooms(text,integer)',
  'v2_request_discovered_room(uuid)','v2_my_discovery_requests()',
  'v2_discovery_inbox()','v2_withdraw_discovery_request(uuid)',
  'v2_review_discovery_request(uuid,uuid,boolean)',
  'v2_block_discovery_room(uuid)','v2_block_discovery_applicant(uuid,uuid)',
  'v2_my_discovery_blocks()','v2_unblock_discovery_user(uuid)',
  'v2_guard_blocked_join()','v2_guard_blocked_membership()',
  'v2_report_discovery_room(uuid,text,text)'
 ] LOOP
  EXECUTE 'REVOKE ALL ON FUNCTION public.'||fn||' FROM PUBLIC,anon,authenticated';
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.v2_set_room_listing(uuid,text,text,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.v2_my_room_listings() TO authenticated;
GRANT EXECUTE ON FUNCTION public.v2_discover_reading_rooms(text,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.v2_request_discovered_room(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.v2_my_discovery_requests() TO authenticated;
GRANT EXECUTE ON FUNCTION public.v2_discovery_inbox() TO authenticated;
GRANT EXECUTE ON FUNCTION public.v2_withdraw_discovery_request(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.v2_review_discovery_request(uuid,uuid,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.v2_block_discovery_room(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.v2_block_discovery_applicant(uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.v2_my_discovery_blocks() TO authenticated;
GRANT EXECUTE ON FUNCTION public.v2_unblock_discovery_user(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.v2_report_discovery_room(uuid,text,text) TO authenticated;
