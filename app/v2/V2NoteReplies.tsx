"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { V2EncryptedDraft } from "./V2EncryptedDraft";
import { removeEncryptedDraft } from "@/lib/v2/encryptedDraft";

type Reply = {
  id: string;
  author_id: string;
  body: string;
  created_at: string;
};

type Props = {
  client: SupabaseClient;
  roomId: string;
  noteId: string;
  userId: string;
  visibility: "private" | "shared";
};

function isReply(raw: unknown): raw is Reply {
  if (!raw || typeof raw !== "object") return false;
  const record = raw as Record<string, unknown>;
  return typeof record.id === "string" &&
    typeof record.author_id === "string" &&
    typeof record.body === "string" &&
    typeof record.created_at === "string";
}

/** Reply list fetches only when opened, avoiding hundreds of requests per book. */
export function V2NoteReplies({ client, roomId, noteId, userId, visibility }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [replies, setReplies] = useState<Reply[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [pendingHide, setPendingHide] = useState<string | null>(null);
  const draftScope = { userId, roomId, kind: "reply" as const, targetId: noteId };
  const [draftBackupRevision,setDraftBackupRevision] = useState(0);

  const load = useCallback(async () => {
    const { data, error } = await client.from("reading_note_replies_v2")
      .select("id,author_id,body,created_at")
      .eq("room_id",roomId).eq("highlight_id",noteId)
      .order("created_at",{ascending:true}).limit(100);
    if (error) {
      setNotice("回复暂时无法加载，请检查 V2 测试数据库权限。");
      return;
    }
    setReplies((data ?? []).filter(isReply));
  }, [client,roomId,noteId]);

  useEffect(() => {
    if (!expanded) return;
    const handle = window.setTimeout(() => { void load(); },0);
    return () => window.clearTimeout(handle);
  },[expanded,load]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !draft.trim() || draft.trim().length > 2000) return;
    setBusy(true);
    const { error } = await client.from("reading_note_replies_v2").insert({
      room_id: roomId,
      highlight_id: noteId,
      author_id: userId,
      body: draft.trim(),
    });
    if (error) {
      setNotice("保存回复失败：可能没有权限、书房已关闭或讨论已达到 100 条上限。");
    } else {
      setDraft("");
      setNotice("回复已保存。");
      try {
        await removeEncryptedDraft(window.localStorage,draftScope);
        setDraftBackupRevision((revision)=>revision+1);
      } catch {
        setNotice("回复已保存，但本机加密备份未清除，请手动删除。");
      }
      await load();
    }
    setBusy(false);
  }

  async function hideReply(id: string) {
    if (busy || pendingHide !== id ||
      !replies.some((reply) => reply.id === id && reply.author_id === userId)) return;
    setBusy(true);
    const { data, error } = await client.rpc("v2_hide_reply", {
      target_room: roomId, target_reply: id,
    });
    setPendingHide(null);
    if (error || data !== true) {
      setNotice("撤销失败：只能撤销自己在活动书房内写下的回复。");
    } else {
      setNotice("自己的回复已从讨论中隐藏，并保留撤销审计记录。");
      await load();
    }
    setBusy(false);
  }

  return (
    <div className="mt-2 border-t border-[#e6ddd0] pt-2">
      <button className="rounded-md px-2 py-1 text-xs text-[#495872] underline-offset-2 hover:underline"
        aria-expanded={expanded}
        type="button" onClick={() => setExpanded((value) => !value)}>
        {expanded ? "收起回复" : visibility === "shared" ? "查看 / 回复共读讨论" : "查看 / 续写私人笔记"}
      </button>
      {expanded && (
        <div className="mt-2 space-y-3">
          <button type="button" className="text-xs underline"
            disabled={busy} onClick={() => { void load(); }}>刷新回复</button>
          {replies.length === 0 && (
            <p className="text-xs text-[#817668]">尚无回复。</p>
          )}
          {replies.map((item) => (
            <div key={item.id} className="rounded-lg bg-[#f3eee5] p-3">
              <p className="mb-1 text-xs text-[#817668]">
                {item.author_id === userId ? "我" : "共读伙伴"}
              </p>
              <p className="whitespace-pre-wrap break-words text-sm">{item.body}</p>
              {item.author_id === userId && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {pendingHide === item.id ? (
                    <>
                      <button type="button" disabled={busy}
                        className="rounded-lg border px-2 py-1 text-xs"
                        onClick={() => { void hideReply(item.id); }}>
                        确认撤销
                      </button>
                      <button type="button" disabled={busy}
                        className="rounded-lg border px-2 py-1 text-xs"
                        onClick={() => setPendingHide(null)}>
                        取消
                      </button>
                    </>
                  ) : (
                    <button type="button" disabled={busy}
                      className="rounded-lg border px-2 py-1 text-xs"
                      onClick={() => setPendingHide(item.id)}>
                      撤销我的回复
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
          <form onSubmit={(event) => { void submit(event); }} className="space-y-2">
            <label className="block text-xs">
              {visibility === "shared" ? "回复这处共读批注" : "追加一条私人想法"}
              <textarea className="mt-1 min-h-20 w-full rounded-lg border border-[#d4c9b8] bg-white p-2 text-sm"
                maxLength={2000} value={draft}
                onChange={(event) => setDraft(event.target.value)} />
            </label>
            <button type="submit" disabled={busy || !draft.trim()}
              className="rounded-lg border border-[#cfc4b3] px-3 py-2 text-xs disabled:opacity-50">
              {busy ? "保存中…" : "发送回复"}
            </button>
          </form>
          <V2EncryptedDraft
            scope={draftScope}
            refreshToken={draftBackupRevision}
            draftValue={draft.trim().length>0 ? draft : ""}
            disabled={busy}
            onRestore={(plaintext) => {
              if (!plaintext.trim() || plaintext.length>2000 ||
                  (draft.trim() && draft!==plaintext)) return false;
              setDraft(plaintext);
              return true;
            }}
          />
        </div>
      )}
      {notice && <p role="status" className="mt-2 text-xs text-[#76563a]">{notice}</p>}
    </div>
  );
}
