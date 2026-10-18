import { prepareTxt, type TxtImportPlan } from "./txt.ts";

/**
 * Browser-only EPUB (ZIP / OCF) text extraction.
 * Zero network requests: XHTML is parsed inertly and never inserted into the DOM.
 * EPUB DRM, images, multimedia, embedded fonts and precise CSS layout are NOT supported.
 */
type Entry = {
  path: string;
  flags: number;
  method: number;
  size: number;
  compressed: number;
  crc: number;
  localOffset: number;
};

type Archive = {
  entries: Map<string, Entry>;
  readText: (path: string) => Promise<string>;
};

const MAX_ZIP_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 2500;
const MAX_ENTRY_UNCOMPRESSED = 4 * 1024 * 1024;
const MAX_TOTAL_DECLARED = 48 * 1024 * 1024;
const MAX_TOTAL_READ = 8 * 1024 * 1024;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function fail(reason: string): never {
  throw new Error("EPUB 无法安全解析：" + reason);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function safePath(path: string): string {
  if (!path || path.startsWith("/") || path.includes("\\") ||
      path.includes("\0") || /^[a-z][a-z0-9+.-]*:/i.test(path)) {
    return fail("包含不安全的文件路径");
  }
  const segments = path.split("/");
  if (segments.some((p) => p === ".." || p === "")) {
    return fail("包含目录穿越或不规范的文件路径");
  }
  return segments.filter((p) => p !== ".").join("/");
}

function resolvePath(base: string, href: string): string {
  if (/^(?:\/\/|[a-z][a-z0-9+.-]*:)/i.test(href)) fail("禁止外部资源路径");
  // Relative references can traverse upward inside the book archive, but
  // must never escape its root. External resource URLs are not loaded.
  let relative: string;
  try {
    relative = decodeURIComponent(href.split(/[?#]/, 1)[0]);
  } catch {
    return fail("章节路径编码无效");
  }
  if (relative.startsWith("/") || relative.includes("\\") ||
      relative.includes("\0")) fail("章节路径不安全");
  const stack = base ? base.split("/") : [];
  for (const part of relative.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!stack.length) fail("章节路径越过 EPUB 根目录");
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return safePath(stack.join("/"));
}

async function inflateRaw(bytes: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  if (typeof DecompressionStream !== "function") {
    return fail("浏览器不支持 EPUB 压缩格式，请使用新版浏览器");
  }
  let decompressor: DecompressionStream;
  try {
    decompressor = new DecompressionStream("deflate-raw");
  } catch {
    return fail("浏览器缺少 deflate-raw 解压支持");
  }
  const safeBuffer = Uint8Array.from(bytes);
  const reader = new Blob([safeBuffer]).stream()
    .pipeThrough(decompressor).getReader();
  const pieces: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return fail("文件解压后超出安全限制");
      }
      pieces.push(value);
    }
  } catch {
    return fail("ZIP 压缩内容损坏或不可解压");
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let pos = 0;
  for (const piece of pieces) {
    result.set(piece, pos);
    pos += piece.byteLength;
  }
  return result;
}

/** ZIP central-directory reader with size, method, path and CRC checks. */
export function readEpubArchive(bytes: Uint8Array): Archive {
  if (bytes.byteLength < 22 || bytes.byteLength > MAX_ZIP_BYTES) {
    fail("文件为空、不完整或超过 8 MB 上限");
  }
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset: number) => data.getUint16(offset, true);
  const u32 = (offset: number) => data.getUint32(offset, true);
  const length = bytes.byteLength;

  let eocd = -1;
  for (let p = length - 22; p >= Math.max(0, length - 22 - 65535); p--) {
    if (u32(p) === 0x06054b50 && p + 22 + u16(p + 20) === length) {
      eocd = p;
      break;
    }
  }
  if (eocd < 0) fail("缺少完整的 ZIP 文件目录");
  if (u16(eocd + 4) !== 0 || u16(eocd + 6) !== 0 ||
      u16(eocd + 8) !== u16(eocd + 10)) {
    fail("不支持分卷 ZIP");
  }
  const count = u16(eocd + 10);
  const directorySize = u32(eocd + 12);
  const directoryStart = u32(eocd + 16);
  if (count === 0 || count > MAX_ENTRIES || directorySize === 0xffffffff ||
      directoryStart === 0xffffffff ||
      directoryStart + directorySize > eocd) {
    fail("ZIP 目录异常或文件数量过多");
  }

  const entries = new Map<string, Entry>();
  let pos = directoryStart;
  let declaredTotal = 0;

  for (let i = 0; i < count; i++) {
    if (pos + 46 > length || u32(pos) !== 0x02014b50) {
      fail("ZIP 文件目录损坏");
    }
    const flags = u16(pos + 8);
    const method = u16(pos + 10);
    const crc = u32(pos + 16);
    const compressed = u32(pos + 20);
    const size = u32(pos + 24);
    const filenameLength = u16(pos + 28);
    const extraLength = u16(pos + 30);
    const commentLength = u16(pos + 32);
    const localOffset = u32(pos + 42);
    const end = pos + 46 + filenameLength + extraLength + commentLength;

    if (end > length || size === 0xffffffff || compressed === 0xffffffff ||
        localOffset === 0xffffffff || size > MAX_ENTRY_UNCOMPRESSED ||
        (flags & 1) !== 0 || (flags & 0x40) !== 0 ||
        (method !== 0 && method !== 8) ||
        (compressed === 0 && size > 0) ||
        (compressed > 0 && size > compressed * 200)) {
      fail("ZIP 存在不支持或过大的文件");
    }
    const rawName = UTF8.decode(bytes.subarray(pos + 46, pos + 46 + filenameLength));
    // Directory entries commonly end in a slash; they are not documents.
    const isDirectory = rawName.endsWith("/");
    const path = safePath(isDirectory ? rawName.slice(0, -1) : rawName);
    if (entries.has(path)) fail("EPUB 包含重复文件名");
    declaredTotal += size;
    if (declaredTotal > MAX_TOTAL_DECLARED) fail("解压后文件总量过大");
    if (!isDirectory) {
      entries.set(path, { path, flags, method, size, compressed, crc, localOffset });
    }
    pos = end;
  }
  if (pos !== directoryStart + directorySize) fail("ZIP 目录长度不匹配");

  let readTotal = 0;
  async function readText(path: string): Promise<string> {
    const entry = entries.get(path);
    if (!entry) return fail("找不到 EPUB 必需内容：" + path);
    if (entry.localOffset + 30 > length || u32(entry.localOffset) !== 0x04034b50) {
      return fail("ZIP 正文头损坏");
    }
    if (u16(entry.localOffset + 8) !== entry.method ||
        u16(entry.localOffset + 6) !== entry.flags) {
      return fail("ZIP 局部文件头与目录不一致");
    }
    const filenameLength = u16(entry.localOffset + 26);
    const extraLength = u16(entry.localOffset + 28);
    const localNameEnd = entry.localOffset + 30 + filenameLength;
    if (localNameEnd > length ||
        UTF8.decode(bytes.subarray(entry.localOffset + 30, localNameEnd)) !== path) {
      return fail("ZIP 文件名与中央目录不一致");
    }
    const start = localNameEnd + extraLength;
    if (start + entry.compressed > directoryStart) return fail("压缩数据越界");
    const source = bytes.subarray(start, start + entry.compressed);
    const inflated = entry.method === 0
      ? Uint8Array.from(source)
      : await inflateRaw(source, entry.size);
    if (inflated.length !== entry.size || crc32(inflated) !== entry.crc) {
      return fail("EPUB 文件长度或校验值不匹配");
    }
    readTotal += inflated.length;
    if (readTotal > MAX_TOTAL_READ) return fail("读取的正文超过 8 MB 限制");
    try {
      return UTF8.decode(inflated).replace(/^\uFEFF/, "");
    } catch {
      return fail("包含非 UTF-8 的 EPUB 文本");
    }
  }
  return { entries, readText };
}

function xmlDocument(text: string): Document {
  // Do not parse DTD/entity declarations from untrusted publications.
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) fail("不支持外部实体或 DTD");
  if (typeof DOMParser !== "function") fail("浏览器不支持 XML 解析");
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) fail("EPUB XML 文件损坏");
  return doc;
}

function byLocalName(element: Document | Element, name: string): Element[] {
  return Array.from(element.getElementsByTagName("*"))
    .filter((el) => el.localName === name);
}

const IGNORED_TAGS = new Set([
  "script", "style", "head", "svg", "math", "iframe", "object",
  "audio", "video", "canvas", "form", "noscript",
]);
const BLOCK_TAGS = new Set([
  "p", "div", "section", "article", "aside", "header", "footer",
  "h1", "h2", "h3", "h4", "h5", "h6", "li", "ul", "ol",
  "blockquote", "pre", "table", "tr", "td", "dt", "dd",
]);

/** Only plain text is extracted: EPUB HTML is never rendered as markup. */
function extractText(node: Node): string {
  if (node.nodeType === 3) return node.nodeValue ?? "";
  if (node.nodeType !== 1 && node.nodeType !== 9) return "";
  const element = node as Element;
  const tag = element.localName?.toLowerCase();
  if (IGNORED_TAGS.has(tag)) return "";
  if (tag === "br") return "\n";
  let value = "";
  node.childNodes.forEach((child) => { value += extractText(child); });
  if (BLOCK_TAGS.has(tag)) return "\n" + value + "\n";
  return value;
}

export async function prepareEpub(bytes: Uint8Array): Promise<TxtImportPlan> {
  const archive = readEpubArchive(bytes);
  const mimetype = await archive.readText("mimetype");
  if (mimetype.trim() !== "application/epub+zip") fail("不是标准 EPUB 文件");
  if (archive.entries.has("META-INF/encryption.xml")) {
    fail("包含 DRM 或加密资源，当前测试版不支持");
  }
  const container = xmlDocument(await archive.readText("META-INF/container.xml"));
  const rootfile = byLocalName(container, "rootfile")[0];
  if (!rootfile) fail("缺少 EPUB 书籍说明");
  const opfPath = safePath(rootfile.getAttribute("full-path") ?? "");
  const opf = xmlDocument(await archive.readText(opfPath));
  const opfDirectory = opfPath.includes("/")
    ? opfPath.slice(0, opfPath.lastIndexOf("/"))
    : "";

  const manifest = new Map<string, { href: string; type: string }>();
  for (const item of byLocalName(opf, "item")) {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    if (id && href && !manifest.has(id)) {
      manifest.set(id, { href, type: item.getAttribute("media-type") ?? "" });
    }
  }
  const itemrefs = byLocalName(opf, "itemref")
    .filter((item) => item.getAttribute("linear") !== "no");
  if (!itemrefs.length || itemrefs.length > 150) fail("EPUB 章节数量不受支持");

  const chapters: { title: string; offset: number }[] = [];
  const parts: string[] = [];
  let offset = 0;

  for (const ref of itemrefs) {
    const item = manifest.get(ref.getAttribute("idref") ?? "");
    if (!item || item.type !== "application/xhtml+xml") {
      fail("书籍包含不支持的正文格式");
    }
    const path = resolvePath(opfDirectory, item.href);
    const doc = xmlDocument(await archive.readText(path));
    const body = byLocalName(doc, "body")[0];
    if (!body) fail("书籍章节缺少正文");
    const raw = extractText(body);
    const readable = raw.replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!readable) continue;
    const titleElement = byLocalName(body, "h1")[0] ?? byLocalName(body, "h2")[0];
    const title = (titleElement?.textContent ?? "").trim().slice(0, 80)
      || "章节 " + (parts.length + 1);
    if (parts.length) offset += 2; // joined chapters are separated by two LF.
    chapters.push({ title, offset });
    parts.push(readable);
    offset += Array.from(readable).length;
    if (offset > 1_000_000) fail("EPUB 正文超过测试版长度上限");
  }
  if (!parts.length) fail("EPUB 没有可提取的文字");
  const plan = prepareTxt(parts.join("\n\n"));
  const ends: number[] = [];
  let sum = 0;
  for (const chunk of plan.chunks) {
    sum += Array.from(chunk).length;
    ends.push(sum);
  }
  return {
    ...plan,
    chapters: chapters.map(({ title, offset: start }) => ({
      title,
      chunkIndex: Math.max(0, ends.findIndex((end) => start < end)),
    })),
  };
}
