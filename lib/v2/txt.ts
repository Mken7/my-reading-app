/** Browser-only TXT preparation. No network requests or persistent storage. */
export type TxtEncoding = "utf-8" | "gb18030";

export type TxtChapter = {
  title: string;
  chunkIndex: number;
};

export type TxtImportPlan = {
  chunks: string[];
  chapters: TxtChapter[];
  codePoints: number;
};

/** Safely decode UTF-8 and legacy Simplified Chinese TXT encodings. */
export function decodeTxt(bytes: Uint8Array, encoding: TxtEncoding): string {
  if (bytes.byteLength === 0) throw new Error("TXT 文件为空");
  return new TextDecoder(encoding, { fatal: true })
    .decode(bytes)
    .replace(/^\uFEFF/, "");
}

/**
 * Deterministic, lossless segmentation (apart from normalizing CR/CRLF to LF).
 * This preserves Chinese/emoji code points and blank lines, and never breaks a
 * surrogate pair. Chunk size is measured in Unicode code points to match
 * PostgreSQL char_length(), not JavaScript UTF-16 code units.
 */
export function prepareTxt(text: string, maxCodePoints = 2800): TxtImportPlan {
  if (!Number.isInteger(maxCodePoints) ||
      maxCodePoints < 1 || maxCodePoints > 3000) {
    throw new Error("TXT 分段长度不合法");
  }

  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!normalized.trim()) throw new Error("TXT 文件没有可阅读的文字");
  // PostgreSQL text cannot store NUL, and binary files masquerading as TXT
  // must fail before the first immutable chunk is uploaded.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(normalized))
    throw new Error("TXT 含二进制或不支持的控制字符，无法安全导入");

  const points = Array.from(normalized);
  if (points.length > 1_000_000) {
    throw new Error("TXT 太大，请选择较短的测试文本");
  }

  const chunks: string[] = [];
  const ends: number[] = [];
  for (let start = 0; start < points.length;) {
    const limit = Math.min(points.length, start + maxCodePoints);
    let end = limit;

    if (limit < points.length) {
      const minBreak = start + Math.floor(maxCodePoints * 0.6);
      // Prefer paragraph breaks without making tiny chunks. Long continuous
      // paragraphs are still split at the hard character limit.
      for (let i = limit - 1; i >= minBreak; i--) {
        if (points[i] === "\n") {
          end = i + 1;
          break;
        }
      }
    }

    chunks.push(points.slice(start, end).join(""));
    ends.push(end);
    start = end;

    if (chunks.length > 2000) {
      throw new Error("TXT 超出测试版 2000 段的上限");
    }
  }

  const candidates: { title: string; offset: number }[] = [];
  // TXT has no navigation metadata. Treat a directory as present only when
  // multiple, unique, standalone headings form an explicit structure; a lone
  // phrase such as “第一章” in body text must never manufacture a TOC.
  const heading = /^(?:第[零〇一二三四五六七八九十百千万亿0-9]+[章节回卷部篇](?:\s*[-—:：、.]?\s*[^\n]+)?|chapter\s+[0-9]+(?:\s*[-—:：.]?\s*[^\n]+)?)$/iu;
  let offset = 0;

  for (const line of normalized.split("\n")) {
    const name = line.trim();
    if (name.length > 0 && name.length <= 80 && heading.test(name) && candidates.length < 200) {
      candidates.push({ title: name, offset });
    }
    offset += Array.from(line).length + 1;
  }

  const isReliable=candidates.length>=2&&new Set(candidates.map(item=>item.title)).size===candidates.length;
  const chapters: TxtChapter[] = !isReliable ? [] : candidates.map(item=>{
    let chunkIndex=0;
    while(chunkIndex<ends.length-1&&item.offset>=ends[chunkIndex])chunkIndex++;
    return {title:item.title,chunkIndex};
  });

  return { chunks, chapters, codePoints: points.length };
}
