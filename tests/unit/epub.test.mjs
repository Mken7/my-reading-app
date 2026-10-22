import test from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { readEpubArchive } from "../../lib/v2/epub.ts";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Synthetic OCF ZIP builder: no external fixtures or npm dependencies. */
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of files) {
    const name = Buffer.from(entry.name, "utf8");
    const body = Buffer.from(entry.body ?? "", "utf8");
    const compressed = entry.method === 8 ? deflateRawSync(body) : body;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.method ?? 0, 8);
    local.writeUInt32LE(crc32(body), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.method ?? 0, 10);
    central.writeUInt32LE(crc32(body), 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

const container = '<?xml version="1.0"?>' +
  '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
  '<rootfiles><rootfile full-path="OPS/content.opf"' +
  ' media-type="application/oebps-package+xml"/></rootfiles></container>';
const opf = '<package xmlns="http://www.idpf.org/2007/opf"><manifest>' +
  '<item id="one" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/>' +
  '</manifest><spine><itemref idref="one"/></spine></package>';
const xhtml = '<html xmlns="http://www.w3.org/1999/xhtml"><body>' +
  '<h1>第一章</h1><p>你好，😀</p></body></html>';

test("reads store and raw-deflate ZIP entries (including directory entries)", async () => {
  const buffer = zip([
    { name: "mimetype", body: "application/epub+zip" },
    { name: "META-INF/", body: "" },
    { name: "META-INF/container.xml", body: container, method: 8 },
    { name: "OPS/content.opf", body: opf },
    { name: "OPS/Text/ch1.xhtml", body: xhtml, method: 8 },
  ]);
  const archive = readEpubArchive(buffer);
  assert.equal(await archive.readText("OPS/Text/ch1.xhtml"), xhtml);
  assert.equal(await archive.readText("META-INF/container.xml"), container);
  assert.equal(archive.entries.has("META-INF/"), false);
});

test("rejects traversal entries and duplicate zip paths", () => {
  assert.throws(() => readEpubArchive(zip([{ name: "../secrets", body: "bad" }])), /不安全|目录穿越/);
  assert.throws(() => readEpubArchive(zip([
    { name: "OPS/item.xhtml", body: "A" },
    { name: "OPS/item.xhtml", body: "B" },
  ])), /重复文件名/);
});

test("rejects CRC mismatches, partial files and missing entries", async () => {
  const valid = zip([{ name: "mimetype", body: "application/epub+zip" }]);
  const damaged = Buffer.from(valid);
  damaged[38] ^= 1;
  await assert.rejects(readEpubArchive(damaged).readText("mimetype"), /校验值/);
  assert.throws(() => readEpubArchive(valid.subarray(0, -7)), /缺少完整/);
  await assert.rejects(readEpubArchive(valid).readText("missing"), /找不到/);
});

test("rejects ZIP bombs before decompression", () => {
  const bomb = zip([{ name: "huge.xhtml", body: "好".repeat(6000), method: 8 }]);
  assert.throws(() => readEpubArchive(bomb), /过大/);
});

test("prevents reading unsupported encrypted entries", () => {
  const zipped = Buffer.from(zip([{ name: "text", body: "abc" }]));
  zipped.writeUInt16LE(1, 37 + 8);
  assert.throws(() => readEpubArchive(zipped), /不支持/);
});
