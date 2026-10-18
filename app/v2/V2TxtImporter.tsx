"use client";

import { useState, type ChangeEvent } from "react";
import { prepareEpub } from "@/lib/v2/epub";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  decodeTxt,
  prepareTxt,
  type TxtEncoding,
  type TxtImportPlan,
} from "@/lib/v2/txt";

type Props = {
  client: SupabaseClient;
  roomId: string;
};

const MAX_TXT_BYTES = 2_000_000;
const MAX_EPUB_BYTES = 8_000_000;
const DAILY_UPLOAD_LIMIT = 300;

const fieldClass =
  "rounded-lg border border-[#cfc4b3] bg-white px-2 py-1.5 text-sm";
const actionClass =
  "rounded-lg border border-[#a99b88] px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50";

/** Stage-only, opt-in upload: opening a file never sends it to Supabase. */
export function V2TxtImporter({ client, roomId }: Props) {
  const [encoding, setEncoding] = useState<TxtEncoding>("utf-8");
  const [plan, setPlan] = useState<TxtImportPlan | null>(null);
  const [fileName, setFileName] = useState("");
  const [previewIndex, setPreviewIndex] = useState(0);
  const [startIndex, setStartIndex] = useState(0);
  const [uploaded, setUploaded] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [consent, setConsent] = useState(false);
  const [notice, setNotice] = useState("");

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (uploading || !file) return;

    setPlan(null);
    setUploaded(0);
    setConsent(false);
    setFileName("");
    setPreviewIndex(0);
    setNotice("");
    try {
      const isEpub = /\.epub$/i.test(file.name);
      if (!isEpub && !/\.txt$/i.test(file.name)) {
        throw new Error("仅支持 .txt 与 .epub 格式");
      }
      const limit = isEpub ? MAX_EPUB_BYTES : MAX_TXT_BYTES;
      if (file.size > limit) {
        throw new Error(isEpub ? "EPUB 文件超过 8 MB 安全上限" : "TXT 文件超过 2 MB 安全上限");
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const prepared = isEpub
        ? await prepareEpub(bytes)
        : prepareTxt(decodeTxt(bytes, encoding));
      setPlan(prepared);
      setFileName(file.name);
      setNotice(
        prepared.chunks.length > DAILY_UPLOAD_LIMIT
          ? "仅允许预览：文件超过测试环境每日 300 段的上传额度，请使用更短的测试文件。"
          : "文本已在本地解析。尚未上传，需你另行确认。",
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "文件读取失败");
    } finally {
      input.value = "";
    }
  }

  async function uploadPlan() {
    if (!plan || uploading || !consent ||
        !Number.isInteger(startIndex) || startIndex < 0 ||
        startIndex + plan.chunks.length > 2000 ||
        plan.chunks.length > DAILY_UPLOAD_LIMIT) return;

    setUploading(true);
    setNotice("");
    let completed = uploaded;

    try {
      for (let i = uploaded; i < plan.chunks.length; i++) {
        // Server verifies owner, membership, immutable index and quotas.
        // Stop on the first failure: never silently skip or overwrite text.
        const { data, error } = await client.rpc("v2_upload_book_chunk", {
          target_room: roomId,
          target_index: startIndex + i,
          chunk_text: plan.chunks[i],
        });
        if (error || data !== true) {
          setNotice(
            `已成功上传 ${completed}/${plan.chunks.length} 段，停止在序号 ${startIndex + i}。可能是旧段落已存在、配额不足或连接中断；请核实后再继续。`,
          );
          return;
        }
        completed = i + 1;
        setUploaded(completed);
      }

      setNotice(`全部 ${completed} 段已上传至独立测试书房。再次选择文件前请勿重复上传。`);
      setPlan(null);
      setConsent(false);
      setFileName("");
    } catch {
      setNotice(`上传中断，已确认 ${completed} 段成功。请检查网络后继续。`);
    } finally {
      setUploading(false);
    }
  }

  return (
    <details className="mt-4 rounded-lg border border-[#ded3c4] bg-white/80 p-3">
      <summary className="cursor-pointer text-sm font-medium">
        TXT / EPUB 本地预览与分段导入（仅测试环境）
      </summary>
      <p className="mt-3 text-xs leading-6 text-[#817668]">
        选择 TXT / EPUB 只在本机解析；EPUB 仅提取正文纯文字，不运行书内脚本，不加载外部资源，
        不支持 DRM、插图与原书精确排版。只有你确认上传，文字才会发送到隔离的测试数据库。
        每次最多 300 段，禁止覆盖既有段落。请仅使用你有权上传的测试文本。
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-xs">
          TXT 文字编码
          <select className={fieldClass + " ml-2"} value={encoding}
            disabled={uploading} onChange={(e) => {
              if (uploading) return;
              setEncoding(e.target.value as TxtEncoding);
              setPlan(null);
              setUploaded(0);
              setConsent(false);
              setNotice("编码已变更，请重新选择 TXT 文件。");
            }}>
            <option value="utf-8">UTF-8</option>
            <option value="gb18030">GB18030 / GBK</option>
          </select>
        </label>
        <label className="text-xs">
          本地 TXT / EPUB 文件
          <input className="ml-2 max-w-full text-xs" type="file" accept=".txt,.epub,text/plain,application/epub+zip"
            disabled={uploading} onChange={(event) => { void handleFile(event); }} />
        </label>
      </div>
      {plan && (
        <div className="mt-4 space-y-3 rounded-lg border border-[#e2d9cb] p-3">
          <p className="break-all text-xs font-medium">{fileName}</p>
          <p className="text-xs text-[#6b6560]">
            本地预览：{plan.codePoints.toLocaleString("zh-CN")} 字符，
            {plan.chunks.length} 段，识别到 {plan.chapters.length} 个章节标题。
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-xs">
              预览段落
              <select className={fieldClass + " ml-2"} value={previewIndex}
                onChange={(e) => setPreviewIndex(Number(e.target.value))}>
                {plan.chunks.map((_, i) => (
                  <option value={i} key={i}>{i + 1}</option>
                ))}
              </select>
            </label>
            {plan.chapters.length > 0 && (
              <label className="text-xs">
                章节定位
                <select className={fieldClass + " ml-2"} value=""
                  onChange={(e) => {
                    if (e.target.value !== "") setPreviewIndex(Number(e.target.value));
                  }}>
                  <option value="">选择章节</option>
                  {plan.chapters.map((item, i) => (
                    <option key={i} value={item.chunkIndex}>{item.title}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[#faf7f0] p-3 text-xs leading-6">
            {plan.chunks[previewIndex]}
          </pre>
          <label className="block text-xs">
            起始序号（0—1999，已有段落不可覆盖）
            <input type="number" className={fieldClass + " ml-2 w-24"}
              min={0} max={1999} step={1} disabled={uploading || uploaded > 0}
              value={startIndex} onChange={(e) => setStartIndex(Number(e.target.value))} />
          </label>
          <label className="flex items-start gap-2 text-xs leading-5">
            <input className="mt-1" type="checkbox" checked={consent}
              disabled={uploading || plan.chunks.length > DAILY_UPLOAD_LIMIT}
              onChange={(e) => setConsent(e.target.checked)} />
            我确认拥有上传权，并同意将本地 TXT / EPUB 提取出的测试文字发送到独立 V2 测试书房。
          </label>
          <button type="button" className={actionClass} onClick={() => { void uploadPlan(); }}
            disabled={uploading || !consent || plan.chunks.length > DAILY_UPLOAD_LIMIT ||
              !Number.isInteger(startIndex) || startIndex < 0 ||
              startIndex + plan.chunks.length > 2000}>
            {uploading ? `上传中 ${uploaded}/${plan.chunks.length}` :
              uploaded > 0 ? `从第 ${uploaded + 1} 段继续` : "确认上传测试文字"}
          </button>
        </div>
      )}
      {notice && <p role="status" className="mt-3 text-xs leading-6 text-[#76563a]">{notice}</p>}
    </details>
  );
}
