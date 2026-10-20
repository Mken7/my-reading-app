#!/usr/bin/env node
// Offline verification. No network calls or file writes.
import {readFileSync} from "node:fs";
import {verifyCheckpoint} from "../lib/v2/auditProof.mjs";
const [evidenceFile,receiptFile,pubKeyFile]=process.argv.slice(2);
if(!evidenceFile||!receiptFile||!pubKeyFile){
 console.error("Usage: node scripts/verify-v2-audit.mjs evidence.json receipt.json pinned-public-key.pem");
 process.exitCode=2;
}else{
 try{
  const evidence=JSON.parse(readFileSync(evidenceFile,"utf8"));
  const receipt=JSON.parse(readFileSync(receiptFile,"utf8"));
  const publicKey=readFileSync(pubKeyFile,"utf8");
  const pass=verifyCheckpoint(evidence,receipt,publicKey);
  console.log(pass?"VERIFIED: independently signed audit evidence matches":"REJECTED: evidence, chain or signature mismatch");
  if(!pass)process.exitCode=1;
 }catch(e){
  console.error("REJECTED: cannot safely parse evidence or trusted verifier key");
  process.exitCode=1;
 }
}
