-- V2 audit foundation: migration order matters; apply reading_access_v2 first.
-- This stores metadata and a SHA-256 hash of note contents, never note plaintext.
-- Hash chaining only detects tampering when a prior head is independently anchored.
-- Admins controlling this database could rewrite an unanchored entire chain.
-- PostgreSQL 16 smoke-tested; not deployed to production.

CREATE TABLE public.reading_audit_v2 (
  room_id uuid NOT NULL REFERENCES public.reading_rooms_v2(id),
  sequence_number bigint NOT NULL CHECK (sequence_number > 0),
  actor_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('note.created','note.updated')),
  note_id uuid NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  previous_hash text NOT NULL CHECK (previous_hash ~ '^[0-9a-f]{64}$'),
  event_hash text NOT NULL CHECK (event_hash ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (room_id, sequence_number)
);
ALTER TABLE public.reading_audit_v2 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reading_audit_v2 FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.v2_audit_note_mutation()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  last_sequence bigint;
  previous text;
  next_sequence bigint;
  kind text;
  payload text;
  payload_digest text;
  happened timestamptz;
  event_payload text;
  digest_hex text;
BEGIN
  -- Mutations within the same room serialize to make each event's sequence
  -- and previous hash deterministic, even for concurrent writes.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(NEW.room_id::text, 14791)
  );

  SELECT a.sequence_number, a.event_hash
  INTO last_sequence, previous
  FROM public.reading_audit_v2 a
  WHERE a.room_id = NEW.room_id
  ORDER BY a.sequence_number DESC
  LIMIT 1;

  next_sequence := COALESCE(last_sequence,0) + 1;
  previous := COALESCE(previous, repeat('0',64));
  kind := CASE WHEN TG_OP = 'INSERT' THEN 'note.created'
               ELSE 'note.updated' END;
  happened := pg_catalog.clock_timestamp();

  -- jsonb produces canonical key ordering for this PostgreSQL version;
  -- store a version marker, and do not change serialization retroactively.
  payload := pg_catalog.jsonb_build_object(
    'version',1,'id',NEW.id,'room',NEW.room_id,'author',NEW.author_id,
    'start',NEW.start_offset,'end',NEW.end_offset,'body',NEW.body,
    'visibility',NEW.visibility,'revision',NEW.revision,
    'created_at',NEW.created_at,'updated_at',NEW.updated_at
  )::text;
  payload_digest := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(payload,'UTF8')), 'hex'
  );

  event_payload := pg_catalog.jsonb_build_object(
    'version',1,'room',NEW.room_id,'sequence',next_sequence,
    'actor',NEW.author_id,'kind',kind,'note',NEW.id,
    'payload_hash',payload_digest,'previous_hash',previous,
    'occurred_at',happened
  )::text;
  digest_hex := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(event_payload,'UTF8')), 'hex'
  );

  INSERT INTO public.reading_audit_v2 (
    room_id,sequence_number,actor_id,action,note_id,payload_hash,
    previous_hash,event_hash,occurred_at
  ) VALUES (
    NEW.room_id,next_sequence,NEW.author_id,kind,NEW.id,payload_digest,
    previous,digest_hex,happened
  );

  RETURN NEW;
END;
$$;

CREATE TRIGGER reading_notes_v2_audit_insert
AFTER INSERT ON public.reading_notes_v2
FOR EACH ROW EXECUTE FUNCTION public.v2_audit_note_mutation();

CREATE TRIGGER reading_notes_v2_audit_update
AFTER UPDATE ON public.reading_notes_v2
FOR EACH ROW EXECUTE FUNCTION public.v2_audit_note_mutation();

REVOKE ALL ON FUNCTION public.v2_audit_note_mutation() FROM PUBLIC,anon,authenticated;

-- No client role can directly view, append, amend or delete audit events.
-- Access for users and moderators will require privacy-reviewed RPCs.
-- Independent signed head anchoring and erasure handling are not included yet.
