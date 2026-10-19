"use client";

import { useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  classifyCompanionPresence, type CompanionPresence,
} from "@/lib/v2/companionPresence";

/** Presence is advisory; the server RPC is always authoritative.
 * Realtime Postgres Changes carries only room/user/last_seen, never content.
 * The event is only a cue to re-fetch a protected, location-free snapshot.
 */
export function useCompanionPresence(
  client: SupabaseClient,
  roomId: string,
  userId: string,
): CompanionPresence {
  const [view, setView] = useState<CompanionPresence>("loading");

  useEffect(() => {
    let closed = false;
    let revision = 0;
    const refresh = async () => {
      const requestRevision = ++revision;
      try {
        const { data, error } = await client.rpc("v2_read_companion_presence", {
          target_room: roomId,
        });
        if (closed || requestRevision !== revision) return;
        setView(error ? "unavailable" : classifyCompanionPresence(data));
      } catch {
        if (!closed && requestRevision === revision) setView("unavailable");
      }
    };

    const heartbeat = async () => {
      if (closed || document.hidden) return;
      try {
        const { data, error } = await client.rpc("v2_heartbeat_reading", {
          target_room: roomId,
        });
        if (closed) return;
        if (error || data !== true) {
          ++revision; // Invalidate stale snapshots after revocation.
          setView("unavailable");
          return;
        }
        void refresh();
      } catch {
        if (!closed) {
          ++revision;
          setView("unavailable");
        }
      }
    };

    // No broadcast messages. This channel is not itself an access check.
    // SELECT RLS on reading_presence_v2 controls each Postgres change.
    const channel = client
      .channel(`v2-presence:${roomId}:${userId}`)
      .on("postgres_changes", {
        event: "*", schema: "public", table: "reading_presence_v2",
        filter: `room_id=eq.${roomId}`,
      }, () => { void refresh(); })
      .subscribe((status) => {
        if (status === "SUBSCRIBED" && !closed) void refresh();
      });

    const onVisibility = () => {
      if (!document.hidden) void heartbeat();
    };
    const onFocus = () => { if (!document.hidden) void heartbeat(); };

    void heartbeat();
    const pulse = window.setInterval(() => { void heartbeat(); }, 30_000);
    const fallback = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 60_000);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);

    return () => {
      closed = true;
      ++revision;
      window.clearInterval(pulse);
      window.clearInterval(fallback);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      void client.removeChannel(channel);
    };
  }, [client, roomId, userId]);

  return view;
}
