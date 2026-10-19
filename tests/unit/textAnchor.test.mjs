import test from "node:test";
import assert from "node:assert/strict";
import {
  validTextAnchor, locateTextOffset, paddedTextRect, anchorFromHumanRange,
} from "../../lib/v2/textAnchor.ts";

test("code-point offsets are translated across React spans and emoji",()=>{
  const spans=["甲😀","乙🐈","丙"];
  assert.deepEqual(locateTextOffset(spans,0),{segmentIndex:0,utf16Offset:0});
  assert.deepEqual(locateTextOffset(spans,1),{segmentIndex:0,utf16Offset:1});
  assert.deepEqual(locateTextOffset(spans,2),{segmentIndex:0,utf16Offset:3});
  assert.deepEqual(locateTextOffset(spans,3),{segmentIndex:1,utf16Offset:1});
  assert.deepEqual(locateTextOffset(spans,4),{segmentIndex:1,utf16Offset:3});
  assert.deepEqual(locateTextOffset(spans,5),{segmentIndex:2,utf16Offset:1});
  assert.equal(locateTextOffset(spans,6),null);
});
test("anchor prevents out of bounds and empty selection",()=>{
  assert.equal(validTextAnchor({start:1,end:4},5),true);
  assert.equal(validTextAnchor({start:4,end:4},5),false);
  assert.equal(validTextAnchor({start:0,end:6},5),false);
  assert.equal(validTextAnchor({start:-1,end:2},5),false);
});
test("layout adjustment follows a moved selected text rectangle",()=>{
  const container={left:50,top:60,width:300,height:400};
  const first=paddedTextRect({left:80,top:100,width:60,height:20},container);
  const reflow=paddedTextRect({left:150,top:170,width:120,height:22},container);
  assert.deepEqual(first,{left:22,top:32,width:76,height:36});
  assert.deepEqual(reflow,{left:92,top:102,width:136,height:38});
  assert.equal(paddedTextRect({left:10,top:10,width:0,height:15},container),null);
});


test("keyboard inclusive Unicode positions map to exact immutable codepoint anchors",()=>{
  const book="甲😀乙🐈丙";
  assert.deepEqual(anchorFromHumanRange(2,4,book),{
    start:1,end:4,quote:"😀乙🐈",
  });
  assert.deepEqual(anchorFromHumanRange(1,1,book),{
    start:0,end:1,quote:"甲",
  });
  assert.equal(anchorFromHumanRange(0,2,book),null);
  assert.equal(anchorFromHumanRange(2,6,book),null);
  assert.equal(anchorFromHumanRange(2.5,4,book),null);
  assert.equal(anchorFromHumanRange(4,2,book),null);
  assert.equal(anchorFromHumanRange(1,1,"   "),null);
});
