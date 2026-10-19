"use client";

import { useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

/** An opaque activity revision is just a refresh cue; no content is in
 * the Realtime payload. The database enforces which annotations are visible.
 */
export function useSharedActivity(
  client: SupabaseClient, roomId: string, userId: string,
): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let closed = false;
    let latest = 0;
    const refresh = async () => {
      try {
        const { data, error } = await client.from("reading_shared_signal_v2")
          .select("revision").eq("room_id", roomId).maybeSingle();
        if (closed || error) return; // Not a trusted signal of room access.
        const next = data?.revision;
        if (typeof next === "number" && Number.isSafeInteger(next) &&
          next > latest) {
          latest = next;
          setRevision(next);
        }
      } catch {
        // Background polling is best-effort; reader interactions remain usable.
      }
    };
    const channel = client.channel(`v2-shared-events:${roomId}:${userId}`)
      .on("postgres_changes", {
        event: "*", schema: "public", table: "reading_shared_signal_v2",
        filter: `room_id=eq.${roomId}`,
      }, () => { void refresh(); })
      .subscribe((status) => {
        if (status === "SUBSCRIBED" && !closed) void refresh();
      });
    const onFocus = () => { if (!document.hidden) void refresh(); };
    const onVisibility = () => { if (!document.hidden) void refresh(); };
    void refresh();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    const fallback = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 60_000);
    return () => {
      closed = true;
      window.clearInterval(fallback);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      void client.removeChannel(channel);
    };
  }, [client,roomId,userId]);
  return revision;
}
