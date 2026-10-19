import test from "node:test";
import assert from "node:assert/strict";
import {
  addEncryptedPending,listEncryptedPending,recoverEncryptedPending,
  removeEncryptedPending,MAX_PENDING_PER_TARGET,
} from "../../lib/v2/draftQueue.ts";

const passphrase="a-unique-safely-stored-test-passphrase";
const scope={userId:"user-1",roomId:"room-1",kind:"highlight",targetId:"42"};
function storage() {
  const records=new Map();
  return {
    records,
    getItem(key) {return records.get(key)??null;},
    setItem(key,value) {records.set(key,value);},
    removeItem(key) {records.delete(key);},
  };
}
function item(id,visibility="private",body="秘密中文😀") {
  return JSON.stringify({v:2,body,operationId:id,start:1,end:3,visibility});
}
function uuid(i) { return "12345678-1234-4123-8123-"+String(i).padStart(12,"0"); }

test("can save 3 distinct encrypted pending notes at the same target",async()=>{
  const local=storage();
  for(let i=1;i<=3;i++) {
    assert.equal(await addEncryptedPending(local,scope,item(uuid(i)),passphrase),uuid(i));
  }
  const ids=await listEncryptedPending(local,scope);
  assert.deepEqual(ids,[uuid(1),uuid(2),uuid(3)]);
  for(const value of local.records.values()) {
    assert.ok(!value.includes("秘密") && !value.includes("private") &&
      !value.includes("user-1") && !value.includes("room-1"));
  }
  assert.equal(await recoverEncryptedPending(local,scope,uuid(2),passphrase),item(uuid(2)));
  await removeEncryptedPending(local,scope,uuid(2));
  assert.deepEqual(await listEncryptedPending(local,scope),[uuid(1),uuid(3)]);
  assert.equal(await recoverEncryptedPending(local,scope,uuid(2),passphrase),null);
  assert.equal(await recoverEncryptedPending(local,scope,uuid(3),passphrase),item(uuid(3)));
});

test("same operation ID cannot overwrite body or private/shared choice",async()=>{
  const local=storage();
  await addEncryptedPending(local,scope,item(uuid(4)),passphrase);
  await addEncryptedPending(local,scope,item(uuid(4)),passphrase);
  assert.equal((await listEncryptedPending(local,scope)).length,1);
  await assert.rejects(addEncryptedPending(local,scope,item(uuid(4),"shared"),passphrase),/不能覆盖/);
  await assert.rejects(addEncryptedPending(local,scope,item(uuid(4),"private","不同文字"),passphrase),/不能覆盖/);
  await assert.rejects(addEncryptedPending(local,scope,item(uuid(4)),"wrongpassword-is-long-enough"),/解锁失败/);
  assert.equal(await recoverEncryptedPending(local,scope,uuid(4),passphrase),item(uuid(4)));
});

test("scope isolation and authenticated queue content cannot be moved to another reader",async()=>{
  const local=storage();
  await addEncryptedPending(local,scope,item(uuid(5)),passphrase);
  assert.deepEqual(await listEncryptedPending(local,{...scope,userId:"user-2"}),[]);
  assert.equal(await recoverEncryptedPending(local,{...scope,userId:"user-2"},uuid(5),passphrase),null);
  assert.deepEqual(await listEncryptedPending(local,{...scope,roomId:"another-room"}),[]);
  assert.deepEqual(await listEncryptedPending(local,{...scope,kind:"reply"}),[]);
});

test("bounded queue protects from uncontrolled local storage growth",async()=>{
  const local=storage();
  for(let i=1;i<=MAX_PENDING_PER_TARGET;i++) {
    await addEncryptedPending(local,scope,item(uuid(i)),passphrase);
  }
  await assert.rejects(addEncryptedPending(local,scope,item(uuid(11)),passphrase),/最多保留/);
  assert.equal((await listEncryptedPending(local,scope)).length,MAX_PENDING_PER_TARGET);
  await removeEncryptedPending(local,scope,uuid(1));
  assert.equal(await addEncryptedPending(local,scope,item(uuid(11)),passphrase),uuid(11));
});

test("corrupt index is rejected instead of dropping or exposing its plaintext",async()=>{
  const local=storage();
  await addEncryptedPending(local,scope,item(uuid(1)),passphrase);
  const key=[...local.records.keys()].find(value=>value.startsWith("reading-v2-pending-index-v1:"));
  assert.ok(key);
  local.setItem(key,"{\"v\":1,\"ids\":[\"wrong\"]}");
  await assert.rejects(listEncryptedPending(local,scope),/格式无效/);
  await assert.rejects(addEncryptedPending(local,scope,item(uuid(2)),passphrase),/格式无效/);
});

test("reply drafts keep stable UUID, without storing body in index",async()=>{
  const local=storage();
  const replyScope={...scope,kind:"reply",targetId:"note-uuid"};
  const plaintext=JSON.stringify({v:2,body:"答复而非广播",operationId:uuid(7)});
  await addEncryptedPending(local,replyScope,plaintext,passphrase);
  assert.equal(await recoverEncryptedPending(local,replyScope,uuid(7),passphrase),plaintext);
  assert.equal(local.records.size,2);
});

test("rejects invalid UUID, missing privacy metadata or nonexistent encrypted record",async()=>{
  const local=storage();
  await assert.rejects(addEncryptedPending(local,scope,"hello",passphrase),/JSON 草稿/);
  await assert.rejects(addEncryptedPending(local,scope,item("invalid"),passphrase),/编号/);
  await assert.rejects(addEncryptedPending(local,scope,JSON.stringify({
    v:2,body:"some text",operationId:uuid(6),start:0,end:2,visibility:"public",
  }),passphrase),/隐私状态/);
  assert.equal(await recoverEncryptedPending(local,scope,uuid(9),passphrase),null);
});
