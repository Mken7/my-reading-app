"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { V2TxtImporter } from "./V2TxtImporter";
import { V2Annotations } from "./V2Annotations";

type ProtectedChunk = { chunk_index: number; body: string };
type Chapter = { chapter_position: number; title: string; start_chunk: number };
type Progress = { chunk_index: number; revision: number };
type Conflict = { desired: number; remote: Progress };
function isProgress(value: unknown): value is Progress {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return Number.isInteger(row.chunk_index) && Number.isInteger(row.revision) &&
    (row.chunk_index as number) >= 0 && (row.revision as number) > 0;
}
function isChapter(value: unknown): value is Chapter {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return Number.isInteger(row.chapter_position) && Number.isInteger(row.start_chunk) &&
    typeof row.title === "string";
}

type Props = {
  client: SupabaseClient;
  roomId: string;
  owner: boolean;
  userId: string;
};

const inputClass =
  "w-full rounded-lg border border-[#cfc4b3] bg-white px-3 py-2 text-sm outline-none focus:border-[#6c4e39]";
const buttonClass =
  "rounded-lg border border-[#cfc4b3] px-3 py-2 text-sm disabled:opacity-50";

export function V2ProtectedBook({ client, roomId, owner, userId }: Props) {
  const [draft, setDraft] = useState("");
  const [uploadIndex, setUploadIndex] = useState(0);
  const [readIndex, setReadIndex] = useState(0);
  const [chunks, setChunks] = useState<ProtectedChunk[]>([]);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [metaLoading, setMetaLoading] = useState(false);

  const refreshMetadata = useCallback(async () => {
    setMetaLoading(true);
    const [directory, bookmark] = await Promise.all([
      client.from("reading_chapters_v2")
        .select("chapter_position,title,start_chunk")
        .eq("room_id", roomId).order("chapter_position").limit(200),
      client.rpc("v2_get_reading_progress", { target_room: roomId }),
    ]);
    if (directory.error || bookmark.error) {
      setMessage("章节与书签同步失败，请检查测试数据库权限。");
    } else {
      setChapters((directory.data ?? []).filter(isChapter));
      const row = Array.isArray(bookmark.data) ? bookmark.data[0] : null;
      setProgress(isProgress(row) ? row : null);
      setConflict(null);
    }
    setMetaLoading(false);
  }, [client, roomId]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refreshMetadata(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshMetadata]);

  async function saveBookmark(index: number, expectedRevision: number) {
    const { data, error } = await client.rpc("v2_save_reading_progress", {
      target_room: roomId, target_chunk: index, expected_revision: expectedRevision,
    });
    const result = Array.isArray(data) ? data[0] : null;
    if (error || !isProgress(result) || !("saved" in result) || typeof result.saved !== "boolean") {
      setMessage("正文读取成功，但同步书签失败，可以稍后重试。");
      return;
    }
    const remote = { chunk_index: result.chunk_index, revision: result.revision };
    setProgress(remote);
    if (result.saved) {
      setConflict(null);
      setMessage("已同步本人的阅读进度。");
    } else {
      setConflict({ desired: index, remote });
      setMessage("另一台设备的书签较新。旧位置未被用于覆盖新记录。");
    }
  }


  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!owner || working || !draft || draft.length > 3000) return;
    setWorking(true);
    setMessage("");
    const { data, error } = await client.rpc("v2_upload_book_chunk", {
      target_room: roomId,
      target_index: uploadIndex,
      chunk_text: draft,
    });
    if (!error && data === true) {
      setMessage("测试文本块已写入受保护的数据库。");
      setDraft("");
      setUploadIndex((index) => Math.min(index + 1, 1999));
    } else {
      setMessage("上传未完成：可能是序号已存在、已达到测试配额，或没有写入权限。");
    }
    setWorking(false);
  }

  async function read(index: number) {
    if (working || !Number.isInteger(index) || index < 0 || index > 1999) return;
    setWorking(true);
    setMessage("");
    const { data, error } = await client.rpc("v2_read_book_chunks", {
      target_room: roomId,
      from_index: index,
      requested_count: 1,
    });
    if (error) {
      setChunks([]);
      setMessage("读取失败，请检查测试数据库接口与网络连接。");
    } else if (!Array.isArray(data) || data.length === 0) {
      setChunks([]);
      setMessage("当前段落不存在、你无权读取，或已达到每小时读取限额。");
    } else {
      const verified: ProtectedChunk[] = data.filter(
        (item): item is ProtectedChunk =>
          typeof item === "object" && item !== null &&
          typeof item.chunk_index === "number" &&
          typeof item.body === "string",
      );
      setChunks(verified);
      setReadIndex(index);
      if (verified.length) await saveBookmark(index, progress?.revision ?? 0);
      else setMessage("服务器返回的数据格式不正确。");
    }
    setWorking(false);
  }

  return (
    <section className="mt-4 rounded-lg border border-[#e0d9cc] bg-[#faf7f0] p-4">
      <h4 className="font-serif text-base">受保护的正文 · 测试</h4>
      <p className="mt-1 text-xs leading-5 text-[#817668]">
        每次按需读取一个不超过 3000 字的段落。服务端核对成员资格，
        每位成员每书房每小时最多读取 60 段。
      </p>
      {owner && (
        <form onSubmit={(event) => { void upload(event); }} className="mt-4 space-y-2">
          <label className="block text-xs">
            测试段落序号（0—1999）
            <input type="number" className={inputClass} min={0} max={1999}
              value={uploadIndex} onChange={(e) => setUploadIndex(Number(e.target.value))} />
          </label>
          <label className="block text-xs">
            上传自己有权使用的短文本（不能覆盖已有段落）
            <textarea className={inputClass + " mt-1 min-h-28"} maxLength={3000}
              value={draft} onChange={(e) => setDraft(e.target.value)}
              placeholder="仅上传测试文字，勿上传真实私人书籍…" />
          </label>
          <button type="submit" className={buttonClass}
            disabled={working || !draft.trim() || draft.length > 3000 ||
              uploadIndex < 0 || uploadIndex > 1999}>
            上传测试段落
          </button>
        </form>
      )}
      {owner && <V2TxtImporter client={client} roomId={roomId}
        onComplete={() => { void refreshMetadata(); }} />}
      <section className="mt-4 rounded-lg border border-[#e2d9cb] bg-white/70 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h5 className="text-sm font-medium">我的阅读书签</h5>
          <button type="button" className={buttonClass} disabled={metaLoading || working}
            onClick={() => { void refreshMetadata(); }}>
            {metaLoading ? "同步中…" : "同步目录与书签"}
          </button>
        </div>
        <p className="mt-2 text-xs text-[#817668]">
          {progress ? "已保存到第 " + (progress.chunk_index + 1) +
            " 段（版本 " + progress.revision + "）" : "暂无书签。阅读后自动同步。"}
        </p>
        {progress && (
          <button type="button" className={buttonClass + " mt-2"} disabled={working}
            onClick={() => { void read(progress.chunk_index); }}>
            从我的书签继续
          </button>
        )}
        {conflict && (
          <div className="mt-3 rounded-lg border border-amber-300 p-3">
            <p className="text-xs leading-5">
              另一设备记录第 {conflict.remote.chunk_index + 1} 段，
              当前阅读的是第 {conflict.desired + 1} 段。
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" className={buttonClass} disabled={working}
                onClick={() => { void read(conflict.remote.chunk_index); }}>
                使用另一设备位置
              </button>
              <button type="button" className={buttonClass} disabled={working}
                onClick={() => {
                  setWorking(true);
                  void saveBookmark(conflict.desired, conflict.remote.revision)
                    .finally(() => setWorking(false));
                }}>
                明确以当前段落覆盖书签
              </button>
            </div>
          </div>
        )}
        <details className="mt-3">
          <summary className="cursor-pointer text-sm">
            章节目录（展开可能显示后续章节名称）
          </summary>
          {chapters.length === 0
            ? <p className="mt-2 text-xs text-[#817668]">暂无已发布章节。</p>
            : <div className="mt-2 flex max-h-52 flex-col gap-2 overflow-auto">
                {chapters.map((chapter) => (
                  <button type="button" key={chapter.chapter_position}
                    disabled={working} className={buttonClass + " text-left"}
                    onClick={() => { void read(chapter.start_chunk); }}>
                    {chapter.title} · 第 {chapter.start_chunk + 1} 段
                  </button>
                ))}
              </div>}
        </details>
      </section>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-xs">
          要阅读的段落
          <input type="number" min={0} max={1999} value={readIndex}
            onChange={(e) => setReadIndex(Number(e.target.value))}
            className="w-24 rounded-lg border border-[#cfc4b3] bg-white px-2 py-1.5" />
        </label>
        <button type="button" className={buttonClass} disabled={working}
          onClick={() => { void read(readIndex); }}>
          读取此段
        </button>
        <button type="button" className={buttonClass}
          disabled={working || readIndex >= 1999}
          onClick={() => { void read(readIndex + 1); }}>
          下一段
        </button>
      </div>
      {message && <p role="status" className="mt-3 text-xs text-[#76563a]">{message}</p>}
      {chunks.map((chunk) => (
        <article key={chunk.chunk_index}
          className="mt-3 rounded-lg border border-[#e7dfd3] bg-white px-4 py-5">
          <p className="mb-2 text-xs text-[#817668]">段落 {chunk.chunk_index + 1}</p>
          <V2Annotations key={roomId + ":" + userId + ":" + chunk.chunk_index}
            client={client} roomId={roomId} userId={userId}
            chunkIndex={chunk.chunk_index} body={chunk.body} />
        </article>
      ))}
    </section>
  );
}
