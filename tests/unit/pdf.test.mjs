import test from "node:test";
import assert from "node:assert/strict";
import {planPdfTextPages,preparePdf} from "../../lib/v2/pdf.ts";

test("PDF local importer rejects invalid header and oversized file before parsing",async()=>{
  await assert.rejects(preparePdf(new TextEncoder().encode("not a PDF")),/不是有效 PDF/);
  await assert.rejects(preparePdf(new Uint8Array(10_000_001)),/超过 10 MB/);
  await assert.rejects(preparePdf(new Uint8Array(0)),/为空/);
});

test("PDF plain-text pages preserve Unicode without manufacturing a directory",()=>{
  const plan=planPdfTextPages([
    {page:1,text:"你好🐈第一章"},
    {page:2,text:"第二页内容😀"},
  ]);
  assert.equal(plan.codePoints,Array.from("你好🐈第一章\n\n第二页内容😀").length);
  assert.equal(plan.chapters.length,0);
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
