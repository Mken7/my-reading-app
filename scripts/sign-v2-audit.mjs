#!/usr/bin/env node
// Operator-only offline signing. Do not commit keys, receipts or evidence.
import {readFileSync,writeFileSync} from "node:fs";
import {verifyAuditRows,signCheckpoint} from "../lib/v2/auditProof.mjs";
const [evidencePath,privateKeyPath,receiptPath]=process.argv.slice(2);
if(!evidencePath||!privateKeyPath||!receiptPath){
 console.error("Usage: node scripts/sign-v2-audit.mjs evidence.json private-key.pem receipt.json");
 process.exitCode=2;
}else{
 try{
  const input=JSON.parse(readFileSync(evidencePath,"utf8"));
  const head=verifyAuditRows(input);
  if(!head.valid)throw Error("Audit chain failed verification");
  const privatePem=readFileSync(privateKeyPath,"utf8");
  const receipt=signCheckpoint(head,privatePem);
  writeFileSync(receiptPath,JSON.stringify(receipt,null,2)+"\n",{flag:"wx",mode:0o600});
  console.log("Signed audit head into the designated receipt file. Store it outside the database.");
 }catch{
  console.error("Refused to sign: invalid evidence/key or output already exists.");
  process.exitCode=1;
 }
}
