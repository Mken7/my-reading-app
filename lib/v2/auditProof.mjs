import { createHash, sign, verify } from "node:crypto";

const HEX=/^[0-9a-f]{64}$/;
function object(input){
 return input&&typeof input==="object"&&!Array.isArray(input);
}
export function verifyAuditRows(evidence){
 if(!object(evidence)||typeof evidence.room_id!=="string"||
  !Array.isArray(evidence.events)||evidence.events.length>5000)
  return {valid:false,reason:"bad_evidence"};
 let prev="0".repeat(64);
 for(let i=0;i<evidence.events.length;i++){
  const event=evidence.events[i];
  if(!object(event)||event.sequence_number!==i+1||
    event.previous_hash!==prev||typeof event.canonical_event!=="string"||
    !HEX.test(String(event.event_hash)))return {valid:false,reason:"sequence_or_hash"};
  let parsed;
  try{parsed=JSON.parse(event.canonical_event);}catch{
   return {valid:false,reason:"bad_canonical_event"};
  }
  if(!object(parsed)||parsed.sequence!==i+1||
    parsed.room!==evidence.room_id||parsed.previous_hash!==prev||
    !HEX.test(String(parsed.payload_hash))||
    typeof parsed.actor!=="string"||
    typeof parsed.note!=="string")return {valid:false,reason:"wrong_event_fields"};
  const digest=createHash("sha256").update(event.canonical_event,"utf8").digest("hex");
  if(digest!==event.event_hash)return {valid:false,reason:"event_changed"};
  prev=digest;
 }
 return {valid:true,room_id:evidence.room_id,
  sequence_number:evidence.events.length,head_hash:prev};
}
export function signCheckpoint(checkpoint,privatePem){
 if(!object(checkpoint)||checkpoint.valid!==true||
 !Number.isSafeInteger(checkpoint.sequence_number)||!HEX.test(String(checkpoint.head_hash)))
 throw new Error("Only validated checkpoints may be signed");
 const manifest={version:1,room_id:checkpoint.room_id,
   sequence_number:checkpoint.sequence_number,head_hash:checkpoint.head_hash};
 const signature=sign(null,Buffer.from(JSON.stringify(manifest),"utf8"),privatePem).toString("base64");
 return {manifest,signature};
}
export function verifyCheckpoint(evidence,receipt,publicPem){
 const head=verifyAuditRows(evidence);
 if(!head.valid||!object(receipt)||!object(receipt.manifest)||
 typeof receipt.signature!=="string")return false;
 const manifest=receipt.manifest;
 if(manifest.version!==1||manifest.room_id!==head.room_id||
 manifest.sequence_number!==head.sequence_number||
 manifest.head_hash!==head.head_hash)return false;
 try{
 return verify(null,Buffer.from(JSON.stringify(manifest),"utf8"),publicPem,
   Buffer.from(receipt.signature,"base64"));
 }catch{return false;}
}
