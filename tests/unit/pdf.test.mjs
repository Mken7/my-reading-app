import test from "node:test";
import assert from "node:assert/strict";
import {planPdfTextPages,preparePdf} from "../../lib/v2/pdf.ts";

function tinyPdf(text="Hello PDF",encrypted=false) {
  const contents="BT /F1 16 Tf 72 740 Td ("+
    text.replace(/[()\\]/g,char=>"\\"+char)+") Tj ET";
  const objects=[
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    "<< /Length "+Buffer.byteLength(contents,"latin1")+" >>\nstream\n"+contents+"\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf="%PDF-1.4\n";
  const offsets=[0];
  for(let i=0;i<objects.length;i++){
    offsets.push(Buffer.byteLength(pdf,"latin1"));
    pdf+=(i+1)+" 0 obj\n"+objects[i]+"\nendobj\n";
  }
  const start=Buffer.byteLength(pdf,"latin1");
  pdf+="xref\n0 "+(objects.length+1)+"\n0000000000 65535 f \n";
  for(const offset of offsets.slice(1)){
    pdf+=String(offset).padStart(10,"0")+" 00000 n \n";
  }
  pdf+="trailer\n<< /Size "+(objects.length+1)+" /Root 1 0 R"+
    (encrypted?" /Encrypt 6 0 R":"")+">>\nstartxref\n"+start+"\n%%EOF";
  return new Uint8Array(Buffer.from(pdf,"latin1"));
}

test("PDF.js extracts real embedded searchable PDF text offline",async()=>{
  const plan=await preparePdf(tinyPdf("Hello World from PDF"));
  assert.ok(plan.chunks.some(chunk=>chunk.includes("Hello World")));
  assert.equal(plan.chapters[0].title,"PDF 第 1 页");
  assert.equal(plan.chapters[0].chunkIndex,0);
});

test("PDF local importer rejects invalid header and oversized file before parsing",async()=>{
  await assert.rejects(preparePdf(new TextEncoder().encode("not a PDF")),/不是有效 PDF/);
  await assert.rejects(preparePdf(new Uint8Array(10_000_001)),/超过 10 MB/);
  await assert.rejects(preparePdf(new Uint8Array(0)),/为空/);
});

test("PDF plain-text pages preserve Unicode codepoints and page anchors",()=>{
  const plan=planPdfTextPages([
    {page:1,text:"你好🐈第一章"},
    {page:2,text:"第二页内容😀"},
  ]);
  assert.equal(plan.codePoints,Array.from("你好🐈第一章\n\n第二页内容😀").length);
  assert.equal(plan.chapters.length,2);
  assert.ok(plan.chunks[0].includes("第二页内容😀"));
});

test("PDF scans without text, excessive pages and character bombs are refused",()=>{
  assert.throws(()=>planPdfTextPages([{page:1,text:"  \n  "}]),/扫描版|可提取/);
  assert.throws(()=>planPdfTextPages(
    Array.from({length:121},(_,i)=>({page:i+1,text:"a"}))
  ),/120 页/);
  assert.throws(()=>planPdfTextPages([{page:1,text:"A".repeat(1_000_001)}]),/100 万/);
});

test("rejects malformed plan input before uploading any document",()=>{
  assert.throws(()=>planPdfTextPages([{page:-1,text:"hello"}]),/编号/);
  assert.throws(()=>planPdfTextPages([]),/页面/);
  assert.throws(()=>planPdfTextPages([{page:1,text:null}]),/文字/);
});
