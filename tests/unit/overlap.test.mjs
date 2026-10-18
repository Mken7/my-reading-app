import test from "node:test";
import assert from "node:assert/strict";
import { buildOverlappingRuns } from "../../lib/v2/overlap.ts";

test("fully overlapping notes both survive without masking", () => {
  const body="ABCDEFG";
  const first={id:"a",author_id:"owner",start_index:1,end_index:5};
  const second={id:"b",author_id:"partner",start_index:3,end_index:7};
  const runs=buildOverlappingRuns(body,[first,second]);
  assert.equal(runs.map(x=>x.text).join(""),body);
  assert.deepEqual(runs.map(x=>[x.text,x.noteIds]),[
    ["A",[]],["BC",["a"]],["DE",["a","b"]],["FG",["b"]],
  ]);
});

test("emoji offsets are Unicode codepoints rather than surrogate halves", () => {
  const body="甲😀乙🐱丙";
  const runs=buildOverlappingRuns(body,[
    {id:"a",author_id:"left",start_index:1,end_index:4},
    {id:"b",author_id:"right",start_index:2,end_index:5},
  ]);
  assert.equal(runs.map(x=>x.text).join(""),body);
  assert.ok(runs.every(x=>!(/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/u).test(x.text)));
  assert.deepEqual(runs.filter(x=>x.noteIds.length===2).map(x=>x.text),["乙🐱"]);
});

test("invalid ranges are ignored while keeping every character", () => {
  const text="Hello";
  const runs=buildOverlappingRuns(text,[
    {id:"bad",author_id:"a",start_index:0,end_index:20},
    {id:"wrong",author_id:"a",start_index:3,end_index:2},
  ]);
  assert.deepEqual(runs.map(x=>x.text),[text]);
  assert.deepEqual(runs[0].noteIds,[]);
});

test("no text and no annotations return predictable layouts", () => {
  assert.deepEqual(buildOverlappingRuns("",[]),[]);
  assert.deepEqual(buildOverlappingRuns("你好",[]),[
    {text:"你好",start:0,end:2,authorIds:[],noteIds:[]},
  ]);
});

test("multiple notes by one person remain distinct", () => {
  const spans=[
    {id:"a",author_id:"same",start_index:0,end_index:3},
    {id:"b",author_id:"same",start_index:0,end_index:3},
  ];
  const runs=buildOverlappingRuns("abc",spans);
  assert.deepEqual(runs[0].noteIds,["a","b"]);
  assert.deepEqual(runs[0].authorIds,["same"]);
});
