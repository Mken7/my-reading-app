import test from "node:test";
import assert from "node:assert/strict";
import {
  spreadSize,readingPageIndex,checkedReaderPages,READER_SPREAD_QUERY,
} from "../../lib/v2/readerLayout.ts";

test("mobile reads exactly one page, desktop reads the next consecutive page",()=>{
  assert.equal(READER_SPREAD_QUERY,"(min-width: 1100px)");
  assert.equal(spreadSize(false),1);
  assert.equal(spreadSize(true),2);
  const pages=[
    {chunk_index:10,body:"甲😀"}, {chunk_index:11,body:"乙🐈"},
    {chunk_index:12,body:"丙"},
  ];
  assert.deepEqual(checkedReaderPages(pages,10,false),[pages[0]]);
  assert.deepEqual(checkedReaderPages(pages,10,true),pages.slice(0,2));
});
test("navigation moves the number of displayed pages without overflow",()=>{
  assert.equal(readingPageIndex(12,1,false),13);
  assert.equal(readingPageIndex(12,1,true),14);
  assert.equal(readingPageIndex(12,-1,true),10);
  assert.equal(readingPageIndex(0,-1,true),0);
  assert.equal(readingPageIndex(1999,1,true),1999);
  assert.equal(readingPageIndex(1998,1,true),1999);
  assert.equal(readingPageIndex(NaN,1,true),2);
});
test("reader rejects gaps, wrong indexes and malformed/unbounded pages",()=>{
  const first={chunk_index:20,body:"真正正文"};
  assert.deepEqual(checkedReaderPages([first,{chunk_index:22,body:"跳段"}],20,true),[first]);
  assert.deepEqual(checkedReaderPages([{chunk_index:21,body:"wrong"}],20,true),[]);
  assert.deepEqual(checkedReaderPages([first,{chunk_index:21,body:"x".repeat(3001)}],20,true),[first]);
  assert.deepEqual(checkedReaderPages([{chunk_index:1999,body:"末页"}],1999,true),[{chunk_index:1999,body:"末页"}]);
  assert.deepEqual(checkedReaderPages("forged",0,true),[]);
  assert.deepEqual(checkedReaderPages([{chunk_index:0,body:"valid"}],-1,true),[]);
});
test("emoji and surrogate pairs are counted by Unicode codepoint",()=>{
  const body="🐈".repeat(3000);
  assert.equal(checkedReaderPages([{chunk_index:0,body}],0,false).length,1);
  assert.equal(checkedReaderPages([{chunk_index:0,body:body+"🐈"}],0,false).length,0);
});
