"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildOverlappingRuns, type V2HighlightRange } from "@/lib/v2/overlap";
import { V2InkOverlay } from "./V2InkOverlay";
import { V2NoteReplies } from "./V2NoteReplies";
import { V2EncryptedDraft } from "./V2EncryptedDraft";
import { removeEncryptedPending,browserPendingMutex } from "@/lib/v2/draftQueue";
import { removeAtomicPending } from "@/lib/v2/atomicPending";
import { browserAtomicPendingStore } from "@/lib/v2/browserAtomicPending";

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
  const [operationId, setOperationId] = useState("");
  const [visibility, setVisibility] = useState<"private" | "shared">("private");
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const draftScope = { userId, roomId, kind: "highlight" as const, targetId: String(chunkIndex) };
  const [draftBackupRevision,setDraftBackupRevision] = useState(0);

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
    if (selected?.start === start && selected?.end === end) return;
    setSelected({ start,end,quote });
    setOperationId(crypto.randomUUID());
  }

  async function submit() {
    if (!selected || working || !draft.trim()) return;
    setWorking(true);
    const submissionId = operationId || crypto.randomUUID();
    if (!operationId) setOperationId(submissionId);
    const { data, error } = await client.rpc("v2_submit_highlight", {
      target_room: roomId,
      target_chunk: chunkIndex,
      target_start: selected.start,
      target_end: selected.end,
      target_body: draft.trim(),
      target_visibility: visibility,
      target_operation: submissionId,
    });
    if (error) {
      setMessage("网络或服务器异常，无法确定本次是否已保存。请保留当前文本和发送编号，稍后重试；可先手动加密备份。");
    } else if (data === "saved" || data === "already_saved") {
      setMessage(data === "already_saved"
        ? "服务器确认这条批注已保存过，本次重试没有生成重复记录。"
        : "已保存批注，重叠范围不会覆盖另一人的笔记。");
      setSelected(null);
      setDraft("");
      setOperationId("");
      try {
        // Only the acknowledged operation may be removed. Do not discard a
        // different unsent legacy single-slot backup for this same target.
        const cleanups=await Promise.allSettled([
          removeAtomicPending(browserAtomicPendingStore,draftScope,submissionId),
          removeEncryptedPending(window.localStorage,draftScope,submissionId,browserPendingMutex),
        ]);
        if (cleanups.some((result)=>result.status==="rejected")) {
          throw new Error("本机存在尚未清理的已发送密文");
        }
        setDraftBackupRevision((revision)=>revision+1);
      } catch {
        setMessage("批注已发送成功，但本地加密备份未能自动清理，请手动删除。");
      }
      window.getSelection()?.removeAllRanges();
      await refresh();
    } else if (data === "conflict") {
      setMessage("发送编号已关联另一版本，未修改服务器记录。请检查当前文字和可见范围，再另建一条发送任务。");
    } else {
      setMessage("服务器拒绝此批注：可能是权限、书房状态或文字选区发生变化。请检查后再试。");
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
      <V2InkOverlay client={client} roomId={roomId}
        chunkIndex={chunkIndex} userId={userId} enabled={showAnnotations}
        selectedText={selected} textRootRef={textRef}>
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
      </V2InkOverlay>
      {showAnnotations && selected && (
        <div className="mt-3 space-y-3 rounded-lg border border-[#d6c8b4] bg-[#f5efe4] p-3">
          <p className="text-xs">已选择：{selected.quote.slice(0,100)}</p>
          <p className="text-xs leading-5 text-[#817668]">
            网络异常时请勿修改这条待发送内容；直接重试会使用原发送编号。
            如果必须退出页面，请先在下方手动加密备份。
          </p>
          <label className="block text-xs">
            笔记
            <textarea className="mt-1 min-h-20 w-full rounded-lg border border-[#cfc4b3] bg-white p-2 text-sm"
              maxLength={2000} value={draft} onChange={(e) => {
                setDraft(e.target.value);
                setOperationId(crypto.randomUUID());
              }}
              placeholder="写下想法，两人可以选中同一段…" />
          </label>
          <label className="flex items-center gap-2 text-xs">
            可见范围
            <select className="rounded-lg border border-[#cfc4b3] bg-white p-2"
              value={visibility}
              onChange={(e) => {
                setVisibility(e.target.value as "private" | "shared");
                setOperationId(crypto.randomUUID());
              }}>
              <option value="private">仅自己可见</option>
              <option value="shared">双方可见</option>
            </select>
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass} disabled={working || !draft.trim()}
              onClick={() => { void submit(); }}>保存批注</button>
            <button type="button" className={buttonClass} disabled={working}
              onClick={() => { setSelected(null);setOperationId("");window.getSelection()?.removeAllRanges(); }}>
              取消
            </button>
          </div>
        </div>
      )}
      {showAnnotations && (
        <V2EncryptedDraft
          scope={draftScope}
          refreshToken={draftBackupRevision}
          draftValue={selected && draft.trim()
            ? JSON.stringify({
                v:2,body:draft,start:selected.start,
                end:selected.end,visibility,operationId,
              })
            : ""}
          disabled={working}
          onRestore={(text) => {
            try {
              const item = JSON.parse(text) as {
                v?:unknown;body?:unknown;start?:unknown;end?:unknown;visibility?:unknown;
                operationId?:unknown;
              };
              const points=Array.from(body);
              if ((item.v!==1 && item.v!==2) || typeof item.body!=="string" ||
                  item.body.trim().length<1 || item.body.length>2000 ||
                  !Number.isInteger(item.start) || !Number.isInteger(item.end) ||
                  typeof item.start!=="number" || typeof item.end!=="number" ||
                  item.start<0 || item.end<=item.start || item.end>points.length ||
                  (item.visibility!=="private" && item.visibility!=="shared") ||
                  (item.v===2 && (typeof item.operationId!=="string" ||
                    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.operationId))) ||
                  !points.slice(item.start,item.end).join("").trim() ||
                  (draft.trim() && draft!==item.body)) return false;
              setSelected({
                start:item.start,end:item.end,
                quote:points.slice(item.start,item.end).join(""),
              });
              setVisibility(item.visibility);
              setDraft(item.body);
              setOperationId(item.v===2 ? item.operationId as string : crypto.randomUUID());
              return true;
            } catch { return false; }
          }}
        />
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
              <V2NoteReplies client={client} roomId={roomId} noteId={note.id}
                userId={userId} visibility={note.visibility} />
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
