\set ON_ERROR_STOP on
\ir reading_retention_v2_smoke.sql
\ir ../../supabase/migrations/20261019190000_v2_security_copyright_audit.sql

-- A new owner-created room already in the isolated fixture is still active.
-- Existing room contents before this migration remain readable.
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000011',false);
SET ROLE authenticated;
DO $copyright_denied$
DECLARE room uuid:=current_setting('test.found_room')::uuid;
BEGIN
 BEGIN
  PERFORM public.v2_upload_book_chunk(room,0,'My own short poem.');
  RAISE EXCEPTION 'upload accepted without copyright attestation';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 IF EXISTS(SELECT 1 FROM public.reading_chunks_v2 WHERE room_id=room) THEN
  RAISE EXCEPTION 'unattested book content was written';
 END IF;
 IF public.v2_confirm_book_rights(room,'unsupported') THEN
  RAISE EXCEPTION 'invalid licensing basis allowed';
 END IF;
 IF NOT public.v2_confirm_book_rights(room,'original') THEN
  RAISE EXCEPTION 'owner declaration denied';
 END IF;
 IF (SELECT count(*) FROM public.v2_my_book_rights(room)
   WHERE rights_basis='original')<>1 THEN
  RAISE EXCEPTION 'rights acknowledgement missing';
 END IF;
 IF public.v2_upload_book_chunk(room,0,'My own short poem.')
   IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'valid attested upload failed';
 END IF;
END $copyright_denied$;
RESET ROLE;

-- Other members cannot assert copyright ownership or read the record.
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000014',false);
SET ROLE authenticated;
DO $copyright_partner$
DECLARE room uuid:=current_setting('test.found_room')::uuid;
BEGIN
 IF public.v2_confirm_book_rights(room,'licensed')
 OR EXISTS(SELECT 1 FROM public.v2_my_book_rights(room)) THEN
  RAISE EXCEPTION 'partner impersonated copyright claimant';
 END IF;
 BEGIN
  PERFORM 1 FROM public.reading_copyright_claims_v2;
  RAISE EXCEPTION 'raw copyright claims leaked';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $copyright_partner$;
RESET ROLE;

-- Create a note audit chain by the owner for the verification endpoint.
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000011',false);
SET ROLE authenticated;
INSERT INTO public.reading_notes_v2(
 room_id,author_id,start_offset,end_offset,body,visibility
) VALUES(current_setting('test.found_room')::uuid,
 '00000000-0000-4000-8000-000000000011',0,2,'Private audit test','private');
DO $owner_audit$
DECLARE check_result jsonb;
BEGIN
 check_result:=public.v2_verify_room_audit(current_setting('test.found_room')::uuid);
 IF check_result->>'valid'<>'true'
 OR (check_result->>'checked_events')::integer<1 OR
 check_result->>'head_hash' !~ '^[0-9a-f]{64}$'
 THEN RAISE EXCEPTION 'valid chained audit not verified: %',check_result; END IF;
END $owner_audit$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000012',false);
SET ROLE authenticated;
DO $audit_outsider$
BEGIN
 IF public.v2_verify_room_audit(current_setting('test.found_room')::uuid)
   IS NOT NULL OR
   EXISTS(SELECT 1 FROM public.v2_export_audit_evidence(
     current_setting('test.found_room')::uuid)) THEN
  RAISE EXCEPTION 'audit secrets accessible without membership/reviewer role';
 END IF;
END $audit_outsider$;
RESET ROLE;

-- A complaint already exists for the blocked room; no ordinary user can
-- directly read report text or make themselves a trusted reviewer.
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000012',false);
SET ROLE authenticated;
DO $reporter_view$
BEGIN
 IF (SELECT count(*) FROM public.v2_my_report_receipts()
 WHERE reason='spam' OR reason='privacy')<1 THEN
  RAISE EXCEPTION 'reporter did not receive private receipt';
 END IF;
 IF EXISTS(SELECT 1 FROM public.v2_review_queue()) OR
 public.v2_decide_report((SELECT report_id FROM public.v2_my_report_receipts() LIMIT 1),
 'reviewed','I reviewed the evidence') THEN
  RAISE EXCEPTION 'reporter became an untrusted moderator';
 END IF;
 BEGIN
  INSERT INTO public.reading_v2_trusted_reviewers(user_id)
  VALUES('00000000-0000-4000-8000-000000000012');
  RAISE EXCEPTION 'self-appointed reviewer granted';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $reporter_view$;
RESET ROLE;

-- Explicit operator-only provisioning simulates external administrative
-- assignment, never a public RPC.
INSERT INTO public.reading_v2_trusted_reviewers(user_id)
VALUES('00000000-0000-4000-8000-000000000014');

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000014',false);
SET ROLE authenticated;
DO $reviewer_case$
DECLARE report uuid;
BEGIN
 SELECT report_id INTO report FROM public.v2_review_queue()
 WHERE reason='spam' LIMIT 1;
 IF report IS NULL THEN RAISE EXCEPTION 'reviewer queue empty'; END IF;
 IF public.v2_decide_report(report,'closed','Skipping evidence review')
 THEN RAISE EXCEPTION 'report closed without review'; END IF;
 IF NOT public.v2_decide_report(report,'reviewed',
   'Evidence was reviewed and categorized')
 OR NOT public.v2_decide_report(report,'closed',
   'Evidence review completed, case closed')
 OR public.v2_decide_report(report,'reviewed','Attempt reopening case')
 THEN RAISE EXCEPTION 'moderation workflow invalid'; END IF;
 IF EXISTS(SELECT 1 FROM public.reading_v2_case_actions)
 THEN RAISE EXCEPTION 'reviewer raw action log accessible'; END IF;
 IF (SELECT count(*) FROM public.v2_export_audit_evidence(
    current_setting('test.found_room')::uuid))<1
 THEN RAISE EXCEPTION 'trusted audit evidence inaccessible'; END IF;
END $reviewer_case$;
RESET ROLE;

-- Tamper with one isolated audit row as a privileged operator and prove
-- the user's protected integrity check detects the change.
UPDATE public.reading_audit_v2 SET event_hash=repeat('f',64)
WHERE room_id=current_setting('test.found_room')::uuid
 AND sequence_number=1;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000011',false);
SET ROLE authenticated;
DO $audit_tamper$
DECLARE result jsonb;
BEGIN
 result:=public.v2_verify_room_audit(current_setting('test.found_room')::uuid);
 IF result->>'valid'<>'false' OR result->>'head_hash' IS NOT NULL
 THEN RAISE EXCEPTION 'audit modification was not detected'; END IF;
END $audit_tamper$;
RESET ROLE;

SET ROLE anon;
DO $unauth$
BEGIN
 BEGIN
  PERFORM public.v2_confirm_book_rights(current_setting('test.found_room')::uuid,'original');
  RAISE EXCEPTION 'anonymous copyright confirmation ran';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 BEGIN
  PERFORM public.v2_review_queue();
  RAISE EXCEPTION 'anonymous moderator queue ran';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 BEGIN
  PERFORM public.v2_verify_room_audit(current_setting('test.found_room')::uuid);
  RAISE EXCEPTION 'anonymous audit integrity RPC ran';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $unauth$;
RESET ROLE;
\echo 'PASS: author copyright attestation, moderator-only case review, trusted audit export and tamper detection'
