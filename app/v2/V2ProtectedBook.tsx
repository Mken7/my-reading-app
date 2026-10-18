"use client";

import { useState, type FormEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { V2TxtImporter } from "./V2TxtImporter";

type ProtectedChunk = { chunk_index: number; body: string };

type Props = {
  client: SupabaseClient;
  roomId: string;
  owner: boolean;
};

const inputClass =
  "w-full rounded-lg border border-[#cfc4b3] bg-white px-3 py-2 text-sm outline-none focus:border-[#6c4e39]";
const buttonClass =
  "rounded-lg border border-[#cfc4b3] px-3 py-2 text-sm disabled:opacity-50";

export function V2ProtectedBook({ client, roomId, owner }: Props) {
  const [draft, setDraft] = useState("");
  const [uploadIndex, setUploadIndex] = useState(0);
  const [readIndex, setReadIndex] = useState(0);
  const [chunks, setChunks] = useState<ProtectedChunk[]>([]);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");

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
      setMessage(verified.length ? "仅显示当前获授权的文本段落。" : "服务器返回的数据格式不正确。");
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
      {owner && <V2TxtImporter client={client} roomId={roomId} />}
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
          <p className="whitespace-pre-wrap break-words text-sm leading-7">{chunk.body}</p>
        </article>
      ))}
    </section>
  );
}
