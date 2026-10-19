import { prepareTxt, type TxtImportPlan } from "./txt.ts";

/** Offline only: PDF.js decodes PDF text in this browser. Never loads document
 * URLs, executes embedded scripts or uploads before an explicit confirmation.
 * Scans, images and DRM-encrypted PDFs are deliberately not OCR'd.
 */
const MAX_PDF_BYTES=10_000_000;
const MAX_PDF_PAGES=120;
const MAX_PDF_CHARACTERS=1_000_000;

type PageText={page:number;text:string};

/** Readable PDFs have positional text, which may be reordered relative to
 * human reading order (columns, tables, vertical writing). Converting to a
 * plain-text reading stream is NOT visual-layout preservation.
 */
function pageText(items:readonly unknown[]):string{
  const lines:string[]=[];
  let buffer="";
  let priorY:number|null=null;
  for(const raw of items){
    if(!raw || typeof raw!=="object" || !("str" in raw))continue;
    const item=raw as {str:unknown;hasEOL?:boolean;transform?:unknown};
    if(typeof item.str!=="string")continue;
    const content=item.str.replace(/\u0000/g,"");
    if(!content && !item.hasEOL)continue;
    const transform=Array.isArray(item.transform)?item.transform:null;
    const y=transform?.[5];
    if(typeof y==="number" && priorY!==null && Math.abs(y-priorY)>4 && buffer.trim()){
      lines.push(buffer.trimEnd());
      buffer="";
    }
    // Keep a word separator between consecutive PDF text items. Some PDFs
    // split glyphs into per-character items; this is only an approximation.
    if(buffer && content && !buffer.endsWith(" ") && !content.startsWith(" ") &&
       /^[a-z0-9]/i.test(content) && /[a-z0-9]$/i.test(buffer)){
      buffer+=" ";
    }
    buffer+=content;
    if(typeof y==="number")priorY=y;
    if(item.hasEOL){
      if(buffer.trim())lines.push(buffer.trimEnd());
      buffer="";
      priorY=null;
    }
  }
  if(buffer.trim())lines.push(buffer.trimEnd());
  return lines.join("\n");
}

export function planPdfTextPages(pages:readonly PageText[]):TxtImportPlan{
  if(pages.length<1 || pages.length>MAX_PDF_PAGES)
    throw new Error("PDF 没有页面或超出 120 页上限");
  const parts:string[]=[];
  const starts:{page:number;offset:number}[]=[];
  let offset=0;
  for(const entry of pages){
    if(!Number.isInteger(entry.page)||entry.page<1 ||
       typeof entry.text!=="string") throw new Error("PDF 页面编号或文字无效");
    const clean=entry.text.replace(/\r\n?/g,"\n").replace(/\u0000/g,"").trim();
    if(!clean)continue;
    if(parts.length)offset+=2;
    starts.push({page:entry.page,offset});
    parts.push(clean);
    offset+=Array.from(clean).length;
    if(offset>MAX_PDF_CHARACTERS)
      throw new Error("PDF 提取的文字超过 100 万字符上限");
  }
  if(!parts.length)throw new Error("PDF 页面没有可提取文字（扫描版需 OCR，当前不支持）");
  const prepared=prepareTxt(parts.join("\n\n"));
  const ends:number[]=[];
  let end=0;
  for(const chunk of prepared.chunks){
    end+=Array.from(chunk).length;
    ends.push(end);
  }
  return {
    ...prepared,
    chapters:starts.map(({page,offset:start})=>({
      title:"PDF 第 "+page+" 页",
      chunkIndex:Math.max(0,ends.findIndex(value=>start<value)),
    })).slice(0,200),
  };
}

export async function preparePdf(bytes:Uint8Array):Promise<TxtImportPlan>{
  if(bytes.byteLength<8 || bytes.byteLength>MAX_PDF_BYTES)
    throw new Error("PDF 为空、不完整或超过 10 MB 安全上限");
  const magic=new TextDecoder("latin1").decode(bytes.subarray(0,8));
  if(!magic.startsWith("%PDF-"))
    throw new Error("文件不是有效 PDF");
  const pdfjs=await import("pdfjs-dist/legacy/build/pdf.mjs");
  // Worker is bundled with the app by the build tool, not downloaded from
  // a third-party CDN. Documents remain local until the user opts to upload.
  pdfjs.GlobalWorkerOptions.workerSrc=new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",import.meta.url,
  ).toString();
  let task:ReturnType<typeof pdfjs.getDocument>|null=null;
  try {
    task=pdfjs.getDocument({
      data:Uint8Array.from(bytes),
      isEvalSupported:false,
      useSystemFonts:false,
      disableFontFace:true,
      useWorkerFetch:false,
      stopAtErrors:true,
    });
    const doc=await task.promise;
    try{
      if(doc.numPages<1 || doc.numPages>MAX_PDF_PAGES)
        throw new Error("PDF 不支持超过 120 页的本地转换");
      const pages:PageText[]=[];
      for(let pageNumber=1;pageNumber<=doc.numPages;pageNumber++){
        const page=await doc.getPage(pageNumber);
        const text=await page.getTextContent();
        pages.push({page:pageNumber,text:pageText(text.items)});
        page.cleanup();
      }
      return planPdfTextPages(pages);
    }finally{await doc.destroy();}
  } catch(error) {
    if(error instanceof Error && /密码|扫描|超过|可提取/.test(error.message))
      throw error;
    throw new Error("PDF 解析失败：文件可能已加密、损坏或使用不支持的字体");
  } finally {
    // PDF.js destroy() is idempotent after the PDF document is destroyed.
    if(task)await task.destroy();
  }
}
