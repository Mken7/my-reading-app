import test from "node:test";
import assert from "node:assert/strict";
import {
  addAtomicPending,listAtomicPending,recoverAtomicPending,removeAtomicPending,
} from "../../lib/v2/atomicPending.ts";

const scope={userId:"reader-A",roomId:"room-A",kind:"highlight",targetId:"42"};
const password="this-is-a-long-local-test-passphrase";
const uuid=(number)=>"12345678-1234-4123-8123-"+String(number).padStart(12,"0");
const draft=(number,visibility="private")=>JSON.stringify({
  v:2,body:"中文密文 "+number+" 😀",visibility,start:1,end:3,operationId:uuid(number),
});

/** Fake atomic store models serialized IndexedDB readwrite transactions.
 * Browser adapter is still subject to an actual-device integration test. */
function atomicStore(rows=new Map()) {
  let preceding=Promise.resolve();
  const write=(action)=>{
    const result=preceding.then(action);
    preceding=result.then(()=>{},()=>{});
    return result;
  };
  return {
    rows,
    async list(scopeId) { return [...rows.values()].filter(row=>row.scope===scopeId); },
    async get(id) { return rows.get(id); },
    async insert(row,limit) {
      return write(async()=>{
        if (rows.has(row.id)) throw Error("该发送编号已经存在");
        if ([...rows.values()].filter(item=>item.scope===row.scope).length>=limit)
          throw Error("超过队列容量");
        rows.set(row.id,row);
      });
    },
    async remove(id) { return write(async()=>{rows.delete(id);}); },
  };
}

test("encrypted drafts survive a re-created store instance and preserve UUID and visibility",async()=>{
  const backing=new Map();
  const initial=atomicStore(backing);
  await addAtomicPending(initial,scope,draft(1),password);
  await addAtomicPending(initial,scope,draft(2,"shared"),password);
  assert.equal(initial.rows.size,2);
  for(const row of backing.values()) {
    assert.ok(!JSON.stringify(row).includes("中文密文"));
    assert.ok(!JSON.stringify(row).includes("private"));
    assert.ok(!JSON.stringify(row).includes("reader-A"));
    assert.ok(!JSON.stringify(row).includes("room-A"));
  }
  const afterReload=atomicStore(backing);
  assert.deepEqual(await listAtomicPending(afterReload,scope),[uuid(1),uuid(2)]);
  assert.equal(await recoverAtomicPending(afterReload,scope,uuid(1),password),draft(1));
  assert.equal(await recoverAtomicPending(afterReload,scope,uuid(2),password),draft(2,"shared"));
});

test("concurrent atomic inserts do not overwrite another unsent item",async()=>{
  const store=atomicStore();
  await Promise.all(Array.from({length:7},(_,index)=>
    addAtomicPending(store,scope,draft(index+1),password)
  ));
  assert.equal((await listAtomicPending(store,scope)).length,7);
  await Promise.all([
    removeAtomicPending(store,scope,uuid(1)),
    addAtomicPending(store,scope,draft(8),password),
  ]);
  const ids=await listAtomicPending(store,scope);
  assert.equal(ids.length,7);
  assert.ok(!ids.includes(uuid(1)));
  assert.ok(ids.includes(uuid(8)));
});

test("duplicate ID never overwrites encrypted body or sharing scope",async()=>{
  const store=atomicStore();
  await addAtomicPending(store,scope,draft(9),password);
  await assert.rejects(addAtomicPending(store,scope,draft(9,"shared"),password),/已经存在/);
  await assert.rejects(addAtomicPending(store,scope,draft(9),password),/已经存在/);
  assert.equal(await recoverAtomicPending(store,scope,uuid(9),password),draft(9));
});

test("scope prevents another reader or room from retrieving drafts",async()=>{
  const store=atomicStore();
  await addAtomicPending(store,scope,draft(1),password);
  assert.deepEqual(await listAtomicPending(store,{...scope,userId:"reader-B"}),[]);
  assert.equal(await recoverAtomicPending(store,{...scope,roomId:"different"},uuid(1),password),null);
  await assert.rejects(recoverAtomicPending(store,scope,uuid(1),"incorrect-password-1234"),/解锁失败/);
});

test("bound per target, reject corrupted rows and preserve intact records",async()=>{
  const store=atomicStore();
  await Promise.all(Array.from({length:10},(_,i)=>
    addAtomicPending(store,scope,draft(i+1),password)
  ));
  await assert.rejects(addAtomicPending(store,scope,draft(11),password),/容量/);
  assert.equal((await listAtomicPending(store,scope)).length,10);
  const first=store.rows.values().next().value;
  first.envelope="{";
  await assert.rejects(recoverAtomicPending(store,scope,uuid(1),password),/损坏/);
  assert.equal(await recoverAtomicPending(store,scope,uuid(2),password),draft(2));
});
