import test from "node:test";
import assert from "node:assert/strict";
import { decodeTxt, prepareTxt } from "../../lib/v2/txt.ts";

test("TXT splits without losing Chinese text or paragraph spacing", () => {
  const original = "第一章 相遇\r\n一行中文。\r\n\r\n第二章 继续\r长句。";
  const plan = prepareTxt(original, 12);
  assert.equal(plan.chunks.join(""), original.replace(/\r\n?/g, "\n"));
  assert.equal(plan.chunks.every((s) => Array.from(s).length <= 12), true);
  assert.deepEqual(plan.chapters.map((item) => item.title), [
    "第一章 相遇", "第二章 继续",
  ]);
  assert.ok(plan.chapters[1].chunkIndex >= plan.chapters[0].chunkIndex);
});

test("each emoji stays intact at a Unicode boundary", () => {
  const original = "中文😀🐈".repeat(100);
  const plan = prepareTxt(original, 13);
  assert.equal(plan.chunks.join(""), original);
  assert.ok(plan.chunks.every((s) => !/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/u.test(s)));
  assert.ok(plan.chunks.every((s) => Array.from(s).length <= 13));
});

test("long unbroken lines split at the maximum", () => {
  const plan = prepareTxt("长".repeat(71), 20);
  assert.deepEqual(plan.chunks.map((c) => c.length), [20,20,20,11]);
});

test("chapter headings are limited and anchored", () => {
  const headings = Array.from({ length: 205 }, (_, i) => `第${i}章 开始`).join("\n");
  const plan = prepareTxt(headings, 30);
  assert.equal(plan.chapters.length, 200);
  assert.equal(prepareTxt("这里有第一章，但不是章节标题").chapters.length, 0);
  assert.equal(prepareTxt("CHAPTER 12 The Visit\nhello").chapters.length,0);
  assert.equal(prepareTxt("第一章 开始\n正文\n第一章 开始\n正文").chapters.length,0);
});

test("invalid and empty TXT inputs are rejected", () => {
  assert.throws(() => prepareTxt("   \r\n  "), /没有可阅读/);
  assert.throws(() => prepareTxt("hi", 3001), /不合法/);
  assert.throws(() => prepareTxt("hi", 0), /不合法/);
  assert.throws(() => prepareTxt("a".repeat(1000001)), /太大/);
  assert.throws(() => prepareTxt("valid\u0000invalid"), /二进制|控制字符/);
  assert.throws(() => prepareTxt("valid\u0007bell"), /二进制|控制字符/);
  assert.equal(prepareTxt("中文\t换行\n测试").chunks.join(""),"中文\t换行\n测试");
});

test("decode validates UTF-8 and strips a BOM", () => {
  const bytes = new TextEncoder().encode("\uFEFF你好，世界");
  assert.equal(decodeTxt(bytes, "utf-8"), "你好，世界");
  assert.throws(() => decodeTxt(new Uint8Array([0xff,0xfe]), "utf-8"));
  assert.throws(() => decodeTxt(new Uint8Array([]), "utf-8"), /为空/);
});

test("GB18030 decoding supports legacy Chinese text", () => {
  // GB18030 encoding for '你好' consists of two GBK-compatible code pairs.
  assert.equal(decodeTxt(new Uint8Array([0xc4,0xe3,0xba,0xc3]), "gb18030"), "你好");
});
