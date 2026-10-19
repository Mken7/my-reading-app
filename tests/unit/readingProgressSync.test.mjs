import test from "node:test";
import assert from "node:assert/strict";
import {
  validReadingCursor,reconcileCursor,expectedCursorRevision,
} from "../../lib/v2/readingProgressSync.ts";

test("remote cursor never automatically changes a locally viewed section",()=>{
  const local={chunk_index:7,revision:3};
  const remote={chunk_index:12,revision:4};
  assert.deepEqual(reconcileCursor(local,remote,7,null),{
    current:remote,changed:true,conflict:{desired:7,remote},
  });
});
test("no false conflict when remote matches current viewing position",()=>{
  assert.deepEqual(reconcileCursor({chunk_index:5,revision:2},{chunk_index:6,revision:3},6,null),{
    current:{chunk_index:6,revision:3},changed:true,conflict:null,
  });
});
test("stale polling never downgrades an updated or pending cursor",()=>{
  const current={chunk_index:15,revision:7};
  const remote={chunk_index:1,revision:6};
  const conflict={desired:12,remote:current};
  assert.deepEqual(reconcileCursor(current,remote,12,conflict),{
    current,conflict,changed:false,
  });
  assert.deepEqual(reconcileCursor(current,null,12,null),{
    current,conflict:null,changed:false,
  });
});
test("unresolved conflict follows newer remote revisions without losing local choice",()=>{
  const old={chunk_index:10,revision:2};
  const next={chunk_index:11,revision:3};
  assert.deepEqual(reconcileCursor(old,next,8,{desired:8,remote:old}),{
    current:next,conflict:{desired:8,remote:next},changed:true,
  });
});
test("initial state and CAS revisions are stable",()=>{
  const remote={chunk_index:2,revision:1};
  assert.deepEqual(reconcileCursor(null,remote,null,null),{
    current:remote,conflict:null,changed:true,
  });
  assert.equal(expectedCursorRevision(null),0);
  assert.equal(expectedCursorRevision(remote),1);
});
test("reject malformed, out-of-range and fractional cursors",()=>{
  for(const input of [null,{}, {chunk_index:-1,revision:1},
    {chunk_index:2000,revision:1},{chunk_index:1.4,revision:1},
    {chunk_index:0,revision:0},{chunk_index:1,revision:"1"}]){
    assert.equal(validReadingCursor(input),false);
  }
  assert.equal(validReadingCursor({chunk_index:1999,revision:10}),true);
});
