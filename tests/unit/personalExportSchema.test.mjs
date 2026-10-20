import test from "node:test";
import assert from "node:assert/strict";
import {
 personalExportSections,validPersonalExportPage,
} from "../../lib/v2/personalExportSchema.ts";

test("personal data is explicitly separated into bounded export sections",()=>{
 assert.deepEqual(personalExportSections,[
 "info","notes","highlights","replies","ink","bookmarks","progress","uploads",
 ]);
});
test("page validator rejects other rooms, wrong categories and fabricated offsets",()=>{
 const good={room_id:"room-A",section:"replies",offset:50,items:[{id:"owned-note"}]};
 assert.equal(validPersonalExportPage(good,"replies","room-A",50),true);
 for(const invalid of [
  null,{},[],{...good,room_id:"room-B"},
  {...good,section:"ink"},{...good,offset:51},
  {...good,items:"not-an-array"},{...good,items:Array(51).fill(null)},
 ]){
  assert.equal(validPersonalExportPage(invalid,"replies","room-A",50),false);
 }
});
