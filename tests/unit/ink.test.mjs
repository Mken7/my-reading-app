import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizedInkPoint, addInkPoint, isValidInkShape,
  inkArrowHead, MAX_INK_POINTS,
} from "../../lib/v2/ink.ts";

test("normalizes touch coordinates into device-independent bounds", () => {
  assert.deepEqual(normalizedInkPoint(150,250,100,200,200,100),{x:250,y:500});
  assert.deepEqual(normalizedInkPoint(-30,999,100,200,200,100),{x:0,y:1000});
  assert.throws(()=>normalizedInkPoint(1,1,0,0,0,1));
});

test("stroke sampling deduplicates and caps point count", () => {
  let points=[{x:0,y:0}];
  points=addInkPoint(points,{x:0,y:0});
  assert.equal(points.length,1);
  for(let i=1;i<250;i++) points=addInkPoint(points,{x:i,y:i});
  assert.equal(points.length,MAX_INK_POINTS);
  assert.equal(points.at(-1).x,127);
});

test("rejects zero-length, out-of-bounds and malformed shapes", () => {
  assert.equal(isValidInkShape({kind:"arrow",points:[{x:0,y:0},{x:800,y:800}]}),true);
  assert.equal(isValidInkShape({kind:"ellipse",points:[{x:1,y:1},{x:1,y:1}]}),false);
  assert.equal(isValidInkShape({kind:"arrow",points:[{x:0,y:0}]}),false);
  assert.equal(isValidInkShape({kind:"stroke",points:[{x:0,y:0},{x:1001,y:1}]}),false);
  assert.equal(isValidInkShape({kind:"ellipse",points:[{x:0,y:0},{x:1,y:1},{x:2,y:2}]}),false);
});

test("arrowheads remain numeric without loading user-supplied markup", () => {
  const path=inkArrowHead({x:10,y:10},{x:500,y:300});
  assert.ok(/^[\d.,\s-]+$/.test(path));
  assert.equal(path.split(" ").length,3);
  assert.equal(inkArrowHead({x:1,y:2},{x:1,y:2}),"");
});
