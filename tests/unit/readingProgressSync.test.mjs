import test from "node:test";
import assert from "node:assert/strict";
import {
  validReadingCursor,validReadingLocation,reconcileCursor,
  expectedCursorRevision,
} from "../../lib/v2/readingProgressSync.ts";

const cursor=(index,offset,rev)=>({chunk_index:index,char_offset:offset,revision:rev});
const loc=(index,offset)=>({chunk_index:index,char_offset:offset});

test("newer remote cursor never changes the locally viewed Unicode location",()=>{
  const local=cursor(7,20,3),remote=cursor(12,10,4);
  assert.deepEqual(reconcileCursor(local,remote,loc(7,20),null),{
    current:remote,changed:true,conflict:{desired:loc(7,20),remote},
  });
});
test("newer cursor with same chunk but different character remains a conflict",()=>{
  const remote=cursor(5,250,9);
  assert.deepEqual(reconcileCursor(cursor(5,12,8),remote,loc(5,12),null),{
    current:remote,changed:true,conflict:{desired:loc(5,12),remote},
  });
  assert.deepEqual(reconcileCursor(cursor(5,12,8),remote,loc(5,250),null),{
    current:remote,changed:true,conflict:null,
  });
});
test("stale polling never downgrades the saved cursor or pending conflict",()=>{
  const current=cursor(15,100,7),remote=cursor(1,0,6);
  const conflict={desired:loc(12,10),remote:current};
  assert.deepEqual(reconcileCursor(current,remote,loc(12,10),conflict),{
    current,conflict,changed:false,
  });
  assert.deepEqual(reconcileCursor(current,null,loc(12,10),null),{
    current,conflict:null,changed:false,
  });
});
test("pending conflict retains the desired char offset after further remote updates",()=>{
  const old=cursor(10,5,2),next=cursor(11,7,3);
  assert.deepEqual(reconcileCursor(old,next,loc(8,15),{desired:loc(8,15),remote:old}),{
    current:next,conflict:{desired:loc(8,15),remote:next},changed:true,
  });
});
test("initial CAS revision must be zero; valid offset has codepoint semantics",()=>{
  const remote=cursor(2,1,1);
  assert.deepEqual(reconcileCursor(null,remote,null,null),{
    current:remote,conflict:null,changed:true,
  });
  assert.equal(expectedCursorRevision(null),0);
  assert.equal(expectedCursorRevision(remote),1);
  assert.equal(validReadingLocation(loc(0,3000)),true);
});
test("reject malformed, out-of-range or fractional Unicode offsets",()=>{
  for(const input of [null,{},cursor(-1,0,1),cursor(2000,0,1),
    cursor(1,3001,1),cursor(1,-1,1),cursor(1,1.2,1),
    cursor(1,1,0),{chunk_index:1,char_offset:2,revision:"1"}]){
    assert.equal(validReadingCursor(input),false);
  }
  assert.equal(validReadingCursor(cursor(1999,3000,10)),true);
});
