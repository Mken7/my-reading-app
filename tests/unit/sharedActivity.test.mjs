import test from "node:test";
import assert from "node:assert/strict";
import { nextSharedRevision } from "../../lib/v2/sharedActivity.ts";

test("events are opaque revisions and never regress after reordering",()=>{
  const packets=[1,3,2,3,5,4,0,-2,8];
  let observed=0;
  const history=[];
  for(const value of packets){
    observed=nextSharedRevision(observed,value);
    history.push(observed);
  }
  assert.deepEqual(history,[1,3,3,3,5,5,5,5,8]);
});
test("reject malformed, textual, future annotation or unsafe-number payloads",()=>{
  for(const packet of [
    null,undefined,"200",{revision:1000,quote:"SPOILER"},true,
    {chunk_index:2000},{body:"private"},[],Number.POSITIVE_INFINITY,
    NaN,1.25,Number.MAX_SAFE_INTEGER+1,
  ])assert.equal(nextSharedRevision(7,packet),7);
});
test("new session starts at zero with malformed stored revision",()=>{
  assert.equal(nextSharedRevision(NaN,20),0);
  assert.equal(nextSharedRevision(-3,20),0);
});
