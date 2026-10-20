-- Module 13, developer staging only. Apply after 20261019180000.
-- Copyright claims are declarations, not proof of legal ownership.
CREATE TABLE public.reading_copyright_claims_v2(
 room_id uuid PRIMARY KEY REFERENCES public.reading_rooms_v2(id) ON DELETE CASCADE,
 claimant_id uuid NOT NULL REFERENCES auth.users(id),
 rights_basis text NOT NULL CHECK(rights_basis IN ('original','public_domain','licensed')),
 affirmation_version integer NOT NULL DEFAULT 1 CHECK(affirmation_version=1),
 affirmed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.reading_copyright_claims_v2 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reading_copyright_claims_v2 FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.v2_confirm_book_rights(target_room uuid,rights_basis text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $$
DECLARE actor uuid:=auth.uid(); room_owner uuid; room_state text;
BEGIN
 IF actor IS NULL OR target_room IS NULL OR rights_basis IS NULL
    OR rights_basis NOT IN ('original','public_domain','licensed') THEN RETURN false; END IF;
 SELECT r.owner_id,r.state INTO room_owner,room_state FROM public.reading_rooms_v2 r
 WHERE r.id=target_room FOR UPDATE;
 IF room_owner IS DISTINCT FROM actor OR room_state IS DISTINCT FROM 'active'
 OR NOT public.v2_can_edit_room(target_room) THEN RETURN false; END IF;
 INSERT INTO public.reading_copyright_claims_v2(room_id,claimant_id,rights_basis)
 VALUES(target_room,actor,rights_basis)
 ON CONFLICT(room_id) DO UPDATE
 SET claimant_id=EXCLUDED.claimant_id,rights_basis=EXCLUDED.rights_basis,
 affirmed_at=now();
 RETURN true;
END;
$$;
CREATE FUNCTION public.v2_my_book_rights(target_room uuid)
RETURNS TABLE(rights_basis text,affirmed_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$
 SELECT c.rights_basis,c.affirmed_at FROM public.reading_copyright_claims_v2 c
 JOIN public.reading_rooms_v2 r ON r.id=c.room_id
 WHERE c.room_id=target_room AND r.owner_id=auth.uid()
 AND public.v2_is_room_member(target_room);
$$;
CREATE FUNCTION public.v2_enforce_book_rights()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.reading_copyright_claims_v2 c
 WHERE c.room_id=NEW.room_id AND c.claimant_id=auth.uid()) THEN
  RAISE EXCEPTION 'Book upload requires an explicit rights declaration'
  USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER reading_chunks_v2_rights_check
 BEFORE INSERT ON public.reading_chunks_v2 FOR EACH ROW
 EXECUTE FUNCTION public.v2_enforce_book_rights();

-- A named auditor/moderator must be provisioned out-of-band by the operator
-- through trusted SQL; client authentication alone never assigns this role.
CREATE TABLE public.reading_v2_trusted_reviewers(
 user_id uuid PRIMARY KEY REFERENCES auth.users(id),
 added_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.reading_v2_trusted_reviewers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reading_v2_trusted_reviewers FROM PUBLIC,anon,authenticated;

CREATE TABLE public.reading_v2_case_actions(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 report_id uuid NOT NULL REFERENCES public.reading_discovery_reports_v2(id),
 reviewer_id uuid NOT NULL REFERENCES auth.users(id),
 disposition text NOT NULL CHECK(disposition IN ('reviewed','closed')),
 action_note text NOT NULL CHECK(char_length(btrim(action_note)) BETWEEN 8 AND 500),
 recorded_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.reading_v2_case_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reading_v2_case_actions FROM PUBLIC,anon,authenticated;

-- Reporter sees only own receipt, no subject's email/reviewer/account details.
CREATE FUNCTION public.v2_my_report_receipts()
RETURNS TABLE(report_id uuid,reason text,status text,created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$
 SELECT r.id,r.reason,r.status,r.created_at
 FROM public.reading_discovery_reports_v2 r WHERE r.reporter_id=auth.uid()
 ORDER BY r.created_at DESC,r.id LIMIT 50;
$$;

-- Trusted reviewers can see case details, never books/notes/chapters.
CREATE FUNCTION public.v2_review_queue()
RETURNS TABLE(report_id uuid,reason text,details text,status text,created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$
 SELECT r.id,r.reason,r.details,r.status,r.created_at
 FROM public.reading_discovery_reports_v2 r
 WHERE auth.uid() IS NOT NULL
  AND EXISTS(SELECT 1 FROM public.reading_v2_trusted_reviewers a WHERE a.user_id=auth.uid())
 ORDER BY r.created_at ASC LIMIT 50;
$$;

CREATE FUNCTION public.v2_decide_report(target_report uuid,next_status text,reasoning text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $$
DECLARE actor uuid:=auth.uid(); previous text;
BEGIN
 IF actor IS NULL OR target_report IS NULL OR next_status NOT IN ('reviewed','closed')
 OR reasoning IS NULL OR char_length(btrim(reasoning)) NOT BETWEEN 8 AND 500
 OR NOT EXISTS(SELECT 1 FROM public.reading_v2_trusted_reviewers a
 WHERE a.user_id=actor) THEN RETURN false; END IF;
 SELECT r.status INTO previous FROM public.reading_discovery_reports_v2 r
 WHERE r.id=target_report FOR UPDATE;
 IF previous IS NULL OR previous='closed'
 OR (previous='pending' AND next_status='closed') THEN RETURN false; END IF;
 UPDATE public.reading_discovery_reports_v2 SET status=next_status WHERE id=target_report;
 INSERT INTO public.reading_v2_case_actions(report_id,reviewer_id,disposition,action_note)
 VALUES(target_report,actor,next_status,btrim(reasoning));
 RETURN true;
END;
$$;

-- Owner may check audit integrity and retrieve only count/head, never raw
-- private note hash inputs. Historical members may inspect after closure.
CREATE FUNCTION public.v2_verify_room_audit(target_room uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=''
AS $$
DECLARE actor uuid:=auth.uid(); previous text:=repeat('0',64);
 n bigint:=0; entry record; expected text; valid boolean:=true;
BEGIN
 IF actor IS NULL OR target_room IS NULL
 OR NOT EXISTS(SELECT 1 FROM public.reading_members_v2 m
    WHERE m.room_id=target_room AND m.user_id=actor)
 THEN RETURN NULL; END IF;
 FOR entry IN SELECT a.* FROM public.reading_audit_v2 a
 WHERE a.room_id=target_room ORDER BY sequence_number LOOP
   n:=n+1;
   expected:=encode(sha256(convert_to(jsonb_build_object(
    'version',1,'room',entry.room_id,'sequence',entry.sequence_number,
    'actor',entry.actor_id,'kind',entry.action,'note',entry.note_id,
    'payload_hash',entry.payload_hash,'previous_hash',entry.previous_hash,
    'occurred_at',entry.occurred_at
   )::text,'UTF8')),'hex');
   IF entry.sequence_number<>n OR entry.previous_hash<>previous
      OR entry.event_hash<>expected THEN
      valid:=false; EXIT;
   END IF;
   previous:=entry.event_hash;
 END LOOP;
 RETURN jsonb_build_object('valid',valid,'checked_events',n,
   'head_hash',CASE WHEN valid THEN previous ELSE NULL END);
END;
$$;

-- Only pre-provisioned trusted reviewers may export canonical event material
-- for an independently retained/signed checksum. No plaintext note bodies.
CREATE FUNCTION public.v2_export_audit_evidence(target_room uuid)
RETURNS TABLE(sequence_number bigint,previous_hash text,event_hash text,
 canonical_event text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$
 SELECT a.sequence_number,a.previous_hash,a.event_hash,
  jsonb_build_object(
    'version',1,'room',a.room_id,'sequence',a.sequence_number,
    'actor',a.actor_id,'kind',a.action,'note',a.note_id,
    'payload_hash',a.payload_hash,'previous_hash',a.previous_hash,
    'occurred_at',a.occurred_at)::text
 FROM public.reading_audit_v2 a
 WHERE a.room_id=target_room AND auth.uid() IS NOT NULL
 AND EXISTS(SELECT 1 FROM public.reading_v2_trusted_reviewers rev
 WHERE rev.user_id=auth.uid())
 ORDER BY a.sequence_number LIMIT 5000;
$$;

DO $$
DECLARE fn text;
BEGIN
 FOREACH fn IN ARRAY ARRAY[
 'v2_confirm_book_rights(uuid,text)','v2_my_book_rights(uuid)',
 'v2_enforce_book_rights()','v2_my_report_receipts()',
 'v2_review_queue()','v2_decide_report(uuid,text,text)',
 'v2_verify_room_audit(uuid)','v2_export_audit_evidence(uuid)'
 ] LOOP
 EXECUTE 'REVOKE ALL ON FUNCTION public.'||fn||' FROM PUBLIC,anon,authenticated';
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.v2_confirm_book_rights(uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.v2_my_book_rights(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.v2_my_report_receipts() TO authenticated;
GRANT EXECUTE ON FUNCTION public.v2_review_queue() TO authenticated;
GRANT EXECUTE ON FUNCTION public.v2_decide_report(uuid,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.v2_verify_room_audit(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.v2_export_audit_evidence(uuid) TO authenticated;
