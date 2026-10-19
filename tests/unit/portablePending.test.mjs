import test from "node:test";
import assert from "node:assert/strict";
import {
  addAtomicPending, recoverAtomicPending, listAtomicPending,
} from "../../lib/v2/atomicPending.ts";
import {
  exportEncryptedPendingBundle, importEncryptedPendingBundle,
} from "../../lib/v2/portablePending.ts";

const scope={userId:"reader-1",roomId:"room-2",kind:"highlight",targetId:"123"};
const secret="portable-encrypted-backup-passphrase";
const uuid=(n)=>"12345678-1234-4123-8123-"+String(n).padStart(12,"0");
const payload=(n,visibility="private")=>JSON.stringify({
  v:2,operationId:uuid(n),body:"私密中文正文 "+n,
  start:1,end:3,visibility,
});

function store(){
  const rows=new Map();
  let previous=Promise.resolve();
  function write(fn){
    const next=previous.then(fn);
    previous=next.then(()=>{},()=>{});
    return next;
  }
  return {
    rows,
    async list(scopeKey){return [...rows.values()].filter(r=>r.scope===scopeKey);},
    async get(id){return rows.get(id);},
    insert(row,limit){return this.insertMany([row],limit);},
    insertMany(batch,limit){
      return write(async()=>{
        if (new Set(batch.map(r=>r.id)).size!==batch.length ||
          batch.some(r=>rows.has(r.id)) ||
          [...rows.values()].filter(r=>r.scope===batch[0].scope).length+batch.length>limit)
          throw new Error("duplicate operation or quota limit");
        batch.forEach(r=>rows.set(r.id,r));
      });
    },
    remove(id){return write(async()=>{rows.delete(id);});},
  };
}

test("exports only encrypted rows and imports back into an independent device",async()=>{
  const first=store();
  await addAtomicPending(first,scope,payload(1),secret);
  await addAtomicPending(first,scope,payload(2,"shared"),secret);
  const file=await exportEncryptedPendingBundle(first,scope);
  assert.ok(!file.includes("私密中文正文"));
  assert.ok(!file.includes('"visibility"'));
  assert.ok(!file.includes("reader-1"));
  assert.ok(!file.includes("room-2"));
  const second=store();
  assert.equal(await importEncryptedPendingBundle(second,scope,file,secret),2);
  assert.deepEqual(await listAtomicPending(second,scope),[uuid(1),uuid(2)]);
  assert.equal(await recoverAtomicPending(second,scope,uuid(2),secret),payload(2,"shared"));
  assert.equal(await recoverAtomicPending(second,scope,uuid(1),secret),payload(1));
});

test("wrong password, target, modified ciphertext and duplicated input all fail atomically",async()=>{
  const source=store();
  await addAtomicPending(source,scope,payload(3),secret);
  const file=await exportEncryptedPendingBundle(source,scope);
  const target=store();
  await assert.rejects(
    importEncryptedPendingBundle(target,scope,file,"incorrect-passphrase-123456"),/解锁失败/);
  await assert.rejects(
    importEncryptedPendingBundle(target,{...scope,roomId:"other"},file,secret),/书房/);
  const tampered=JSON.parse(file);
  tampered.records[0].envelope=tampered.records[0].envelope.replace(/A/,"B");
  // Any changed authenticated metadata or ciphertext cannot be accepted.
  await assert.rejects(
    importEncryptedPendingBundle(target,scope,JSON.stringify(tampered),secret));
  assert.equal(target.rows.size,0);
  assert.equal(await importEncryptedPendingBundle(target,scope,file,secret),1);
  await assert.rejects(importEncryptedPendingBundle(target,scope,file,secret),/duplicate/);
  assert.equal(target.rows.size,1);
});

test("one malformed entry in a file never writes the other valid entry",async()=>{
  const source=store();
  await addAtomicPending(source,scope,payload(5),secret);
  await addAtomicPending(source,scope,payload(6),secret);
  const file=JSON.parse(await exportEncryptedPendingBundle(source,scope));
  file.records[1].envelope="{";
  const target=store();
  await assert.rejects(
    importEncryptedPendingBundle(target,scope,JSON.stringify(file),secret),/密文/);
  assert.equal(target.rows.size,0);
});

test("portable import does not displace existing drafts when near quota",async()=>{
  const source=store();
  await addAtomicPending(source,scope,payload(11),secret);
  await addAtomicPending(source,scope,payload(12),secret);
  const file=await exportEncryptedPendingBundle(source,scope);
  const target=store();
  for (let i=1;i<=9;i++) await addAtomicPending(target,scope,payload(i),secret);
  await assert.rejects(importEncryptedPendingBundle(target,scope,file,secret),/quota/);
  assert.equal(target.rows.size,9);
  assert.equal(await recoverAtomicPending(target,scope,uuid(1),secret),payload(1));
});

test("export refuses empty, damaged, or invalid-scope entries",async()=>{
  const db=store();
  await assert.rejects(exportEncryptedPendingBundle(db,scope),/暂无/);
  await addAtomicPending(db,scope,payload(9),secret);
  const item=[...db.rows.values()][0];
  item.envelope="{";
  await assert.rejects(exportEncryptedPendingBundle(db,scope),/受损/);
});
