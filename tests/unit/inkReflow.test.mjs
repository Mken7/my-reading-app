import test from "node:test";
import assert from "node:assert/strict";
import {groupedVisualLines,singleLineInkBounds} from "../../lib/v2/inkReflow.ts";

const outer={left:0,top:0,width:640,height:500};
const box=(left,top,width,height=22)=>({left,top,width,height});

test("merge separate highlighted spans on the same visual line",()=>{
  const lines=groupedVisualLines([box(140,70,60),box(10,70,80),box(92,70,35)]);
  assert.deepEqual(lines,[box(10,70,190)]);
  assert.deepEqual(singleLineInkBounds([box(10,70,190)],outer),{
    left:2,top:62,width:206,height:38,
  });
});

test("never stretch an anchored drawing across a wrap after resize",()=>{
  const original=[box(30,12,125)];
  const wrapped=[box(30,12,300),box(15,54,100)];
  assert.ok(singleLineInkBounds(original,outer));
  assert.equal(singleLineInkBounds(wrapped,outer),null);
  // When layout returns to one line, its original glyph anchor can return.
  assert.ok(singleLineInkBounds([box(70,20,160)],outer));
});

test("reflow with independent text nodes on the same line remains renderable",()=>{
  const split=[box(15,40,20),box(36,42,20),box(60,40,20)];
  assert.equal(groupedVisualLines(split).length,1);
});

test("rejects empty, zero-sized or malformed geometry",()=>{
  assert.equal(singleLineInkBounds([],outer),null);
  assert.equal(singleLineInkBounds([box(20,20,0)],outer),null);
  assert.equal(singleLineInkBounds([box(Infinity,0,10)],outer),null);
  assert.equal(singleLineInkBounds([box(12,12,25)],{...outer,width:0}),null);
});
