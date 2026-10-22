-- Module 10 (part 1): spoiler-free companion presence. STAGING ONLY.
-- Never apply directly to legacy/production Supabase. Run after
-- 20261019011000_v2_room_lifecycle.sql and test in a disposable project.
-- No chapter, cursor, book text, quoted content or private note is published.
CREATE TABLE public.reading_presence_v2 (
  room_id uuid NOT NULL,
  user_id uuid NOT NULL,
  last_seen timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (room_id,user_id),
  FOREIGN KEY (room_id,user_id)
    REFERENCES public.reading_members_v2(room_id,user_id) ON DELETE CASCADE
);

ALTER TABLE public.reading_presence_v2 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reading_presence_v2 FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.reading_presence_v2 TO authenticated;

-- Realtime's Postgres Changes delivers only rows readable via RLS.
-- A removed member cannot query the presence table; old left members are
-- not shown even to remaining members. No client INSERT/UPDATE/DELETE grant.
CREATE POLICY reading_presence_v2_active_room_select
ON public.reading_presence_v2 FOR SELECT TO authenticated
USING (
  public.v2_can_edit_room(room_id)
  AND EXISTS(
    SELECT 1 FROM public.reading_members_v2 m
    WHERE m.room_id=reading_presence_v2.room_id
      AND m.user_id=reading_presence_v2.user_id
      AND m.left_at IS NULL
  )
);

-- Authoritative heartbeat: no user-provided actor ID or timestamp, and at
-- most one DB UPDATE per 20 seconds for each room/user, regardless of tabs.
CREATE FUNCTION public.v2_heartbeat_reading(target_room uuid)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $$
DECLARE actor uuid:=auth.uid();
BEGIN
  IF actor IS NULL OR target_room IS NULL
     OR NOT public.v2_can_edit_room(target_room) THEN RETURN false; END IF;

  INSERT INTO public.reading_presence_v2(room_id,user_id,last_seen)
  VALUES (target_room,actor,pg_catalog.now())
  ON CONFLICT (room_id,user_id) DO UPDATE
    SET last_seen=EXCLUDED.last_seen
    WHERE public.reading_presence_v2.last_seen
      <= pg_catalog.now() - interval '20 seconds';
  RETURN true;
END;
$$;

-- Returns no row for outsider/closed room, and never returns names, IDs,
-- book content, location, selected text or timestamps of either reader.
-- "Active" means a validated heartbeat within the last 90 seconds.
CREATE FUNCTION public.v2_read_companion_presence(target_room uuid)
RETURNS TABLE(partner_joined boolean,partner_active boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=''
AS $$
DECLARE actor uuid:=auth.uid();
BEGIN
  IF actor IS NULL OR target_room IS NULL
     OR NOT public.v2_can_edit_room(target_room) THEN RETURN; END IF;

  RETURN QUERY
  SELECT
    EXISTS (
      SELECT 1 FROM public.reading_members_v2 m
      WHERE m.room_id=target_room AND m.user_id<>actor AND m.left_at IS NULL
    ),
    EXISTS (
      SELECT 1 FROM public.reading_members_v2 m
      JOIN public.reading_presence_v2 p
        ON p.room_id=m.room_id AND p.user_id=m.user_id
      WHERE m.room_id=target_room AND m.user_id<>actor
        AND m.left_at IS NULL
        AND p.last_seen >= pg_catalog.now()-interval '90 seconds'
    );
END;
$$;

REVOKE ALL ON FUNCTION public.v2_heartbeat_reading(uuid)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.v2_read_companion_presence(uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.v2_heartbeat_reading(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.v2_read_companion_presence(uuid) TO authenticated;

-- Supabase projects have supabase_realtime; isolated PG CI may not.
-- Do not publish positions or other private book tables.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_publication
    WHERE pubname='supabase_realtime' AND NOT puballtables
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_publication_tables
    WHERE pubname='supabase_realtime'
      AND schemaname='public' AND tablename='reading_presence_v2'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.reading_presence_v2;
  END IF;
END;
$$;
