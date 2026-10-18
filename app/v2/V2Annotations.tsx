"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildOverlappingRuns, type V2HighlightRange } from "@/lib/v2/overlap";

type HighlightRow = V2HighlightRange & {
  body: string;
  visibility: "private" | "shared";
  created_at: string;
};
type Selection = { start: number; end: number; quote: string };
type Props = {
  client: SupabaseClient;
  roomId: string;
  chunkIndex: number;
  body: string;
  userId: string;
  fontSize?: number;
  lineHeight?: number;
  showAnnotations?: boolean;
};

const buttonClass =
  "rounded-lg border border-[#cfc4b3] px-3 py-2 text-sm disabled:opacity-50";

function validHighlight(value: unknown): value is HighlightRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && typeof row.author_id === "string" &&
    Number.isInteger(row.start_index) && Number.isInteger(row.end_index) &&
    typeof row.body === "string" &&
    (row.visibility === "private" || row.visibility === "shared") &&
    typeof row.created_at === "string";
}

/** All note positions are relative to one immutable, codepoint-indexed chunk. */
export function V2Annotations({ client, roomId, chunkIndex, body, userId, fontSize = 16, lineHeight = 1.9, showAnnotations = true }: Props) {
  const textRef = useRef<HTMLDivElement>(null);
  const [annotations, setAnnotations] = useState<HighlightRow[]>([]);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [draft, setDraft] = useState("");
  const [visibility, setVisibility] = useState<"private" | "shared">("private");
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");

  const refresh = useCallback(async () => {
    const { data, error } = await client
      .from("reading_highlights_v2")
      .select("id,author_id,start_index,end_index,body,visibility,created_at")
      .eq("room_id", roomId)
      .eq("chunk_index", chunkIndex)
      .order("created_at", { ascending: true })
      .limit(150);
    if (error) {
      setMessage("无法读取批注。请检查独立测试库的权限迁移。");
      return;
    }
    setAnnotations((data ?? []).filter(validHighlight));
  }, [client, roomId, chunkIndex]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const runs = useMemo(
    () => buildOverlappingRuns(body, annotations),
    [body, annotations],
  );

  function captureSelection() {
    if (!showAnnotations) return;
    const root = textRef.current;
    const selection = window.getSelection();
    if (!root || !selection || selection.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
      return;
    }

    // A DOM Range reports UTF-16 offsets, but our database and renderer
    // use Unicode code points. Count selected prefix text, not DOM code units.
    const startRange = document.createRange();
    startRange.selectNodeContents(root);
    startRange.setEnd(range.startContainer, range.startOffset);
    const endRange = document.createRange();
    endRange.selectNodeContents(root);
    endRange.setEnd(range.endContainer, range.endOffset);
    const start = Array.from(startRange.toString()).length;
    const end = Array.from(endRange.toString()).length;
    if (start >= end || end > Array.from(body).length) return;
    const quote = Array.from(body).slice(start,end).join("");
    if (!quote.trim()) return;
    setSelected({ start,end,quote });
  }

  async function submit() {
    if (!selected || working || !draft.trim()) return;
    setWorking(true);
    const { error } = await client.from("reading_highlights_v2").insert({
      room_id: roomId,
      chunk_index: chunkIndex,
      author_id: userId,
      start_index: selected.start,
      end_index: selected.end,
      body: draft.trim(),
      visibility,
    });
    if (error) {
      setMessage("批注保存失败：可能没有写入权限或选区超出正文。");
    } else {
      setMessage("已保存批注，重叠范围不会覆盖另一人的笔记。");
      setSelected(null);
      setDraft("");
      window.getSelection()?.removeAllRanges();
      await refresh();
    }
    setWorking(false);
  }

  return (
    <section className="mt-2">
      {showAnnotations && <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-[#817668]">
          在正文中选中文字做批注。蓝色代表我，红色代表伙伴，紫色代表重叠。
        </p>
        <button type="button" className={buttonClass} disabled={working}
          onClick={() => { void refresh(); }}>刷新批注</button>
      </div>}
      <div
        ref={textRef}
        className="select-text whitespace-pre-wrap break-words"
        style={{ fontSize, lineHeight }}
        onMouseUp={captureSelection}
        onKeyUp={captureSelection}
        onTouchEnd={() => { window.setTimeout(captureSelection, 30); }}
        role="document"
        aria-label={showAnnotations ? "阅读正文，可选择文字创建批注" : "阅读正文（隐藏批注）"}
      >
        {showAnnotations ? runs.map((run) => {
          const mine = run.authorIds.includes(userId);
          const partner = run.authorIds.some((author) => author !== userId);
          const mark = mine && partner
            ? "bg-violet-200 underline decoration-double decoration-violet-700"
            : mine ? "bg-blue-100 underline decoration-blue-600"
            : partner ? "bg-rose-100 underline decoration-rose-600" : "";
          return <span className={mark} key={run.start}>{run.text}</span>;
        }) : body}
      </div>
      {showAnnotations && selected && (
        <div className="mt-3 space-y-3 rounded-lg border border-[#d6c8b4] bg-[#f5efe4] p-3">
          <p className="text-xs">已选择：{selected.quote.slice(0,100)}</p>
          <label className="block text-xs">
            笔记
            <textarea className="mt-1 min-h-20 w-full rounded-lg border border-[#cfc4b3] bg-white p-2 text-sm"
              maxLength={2000} value={draft} onChange={(e) => setDraft(e.target.value)}
              placeholder="写下想法，两人可以选中同一段…" />
          </label>
          <label className="flex items-center gap-2 text-xs">
            可见范围
            <select className="rounded-lg border border-[#cfc4b3] bg-white p-2"
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as "private" | "shared")}>
              <option value="private">仅自己可见</option>
              <option value="shared">双方可见</option>
            </select>
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass} disabled={working || !draft.trim()}
              onClick={() => { void submit(); }}>保存批注</button>
            <button type="button" className={buttonClass} disabled={working}
              onClick={() => { setSelected(null); window.getSelection()?.removeAllRanges(); }}>
              取消
            </button>
          </div>
        </div>
      )}
      {message && <p role="status" className="mt-2 text-xs text-[#76563a]">{message}</p>}
      {showAnnotations && annotations.length > 0 && (
        <div className="mt-3 space-y-2">
          <h5 className="text-sm font-medium">这段文字的批注</h5>
          {annotations.map((note) => (
            <article key={note.id} className="rounded-lg border border-[#e2d9cb] bg-white/80 p-3">
              <p className="mb-1 text-xs text-[#817668]">
                {note.author_id === userId ? "我" : "共读伙伴"} ·
                {note.visibility === "private" ? " 私人笔记" : " 双方共享"} ·
                第 {note.start_index + 1} 至 {note.end_index} 字
              </p>
              <p className="whitespace-pre-wrap break-words text-sm leading-6">{note.body}</p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
