import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createHash } from "node:crypto";
import {verifyAuditRows,signCheckpoint,verifyCheckpoint} from "../../lib/v2/auditProof.mjs";

const room="00000000-0000-4000-8000-000000000099";
const canonical=JSON.stringify({version:1,room,sequence:1,actor:"actor",
 kind:"note.created",note:"note-id",payload_hash:"a".repeat(64),
 previous_hash:"0".repeat(64),occurred_at:"2026-10-20T04:00:00Z"});
const event={sequence_number:1,previous_hash:"0".repeat(64),
 canonical_event:canonical,event_hash:createHash("sha256").update(canonical).digest("hex")};
const evidence={room_id:room,events:[event]};
const {privateKey,publicKey}=generateKeyPairSync("ed25519");

test("detached external signature authenticates an exact audit head",()=>{
 const result=verifyAuditRows(evidence);
 assert.equal(result.valid,true);
 assert.equal(result.sequence_number,1);
 const receipt=signCheckpoint(result,privateKey);
 assert.equal(verifyCheckpoint(evidence,receipt,publicKey),true);
 assert.equal(verifyCheckpoint({...evidence,room_id:"other"},receipt,publicKey),false);
 assert.equal(verifyCheckpoint(evidence,{...receipt,signature:"AAAA"},publicKey),false);
 assert.equal(verifyCheckpoint(evidence,{
  ...receipt,manifest:{...receipt.manifest,head_hash:"f".repeat(64)}
 },publicKey),false);
});
test("any deleted, reordered, changed or extra event invalidates proof",()=>{
 const modified={...event,event_hash:"f".repeat(64)};
 const wrongPrevious={...event,previous_hash:"f".repeat(64)};
 const canonicalEdited={...event,canonical_event:canonical.replace("note.created","note.updated")};
 for(const e of [[modified],[wrongPrevious],[canonicalEdited],[event,event]]){
  assert.equal(verifyAuditRows({room_id:room,events:e}).valid,false);
 }
 const receipt=signCheckpoint(verifyAuditRows(evidence),privateKey);
 assert.equal(verifyCheckpoint({room_id:room,events:[]},receipt,publicKey),false);
});
test("untrusted manifest shape cannot be signed",()=>{
 assert.throws(()=>signCheckpoint({valid:false},privateKey));
 assert.equal(verifyAuditRows({room_id:room,events:"not an array"}).valid,false);
});
