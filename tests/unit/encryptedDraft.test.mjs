import test from "node:test";
import assert from "node:assert/strict";
import {
  encryptedDraftKey, saveEncryptedDraft, recoverEncryptedDraft,
  removeEncryptedDraft,hasEncryptedDraft,
} from "../../lib/v2/encryptedDraft.ts";

function storage() {
  const content = new Map();
  return {
    getItem(key) { return content.get(key) ?? null; },
    setItem(key,value) { content.set(key,value); },
    removeItem(key) { content.delete(key); },
    contents: content,
  };
}
const scope = {
  userId:"reader-1",roomId:"room-abc",kind:"highlight",targetId:"chunk-42",
};
const pass="a-stronger-than-test-phrase-2026";

test("only authenticated ciphertext is persisted and can be unlocked",async()=>{
  const memory = storage();
  const body = JSON.stringify({body:"中文😀 的私人思考",start:1,end:3});
  await saveEncryptedDraft(memory,scope,body,pass);
  const key=await encryptedDraftKey(scope);
  assert.equal(memory.contents.size,1);
  assert.ok(key.startsWith("reading-v2-encrypted-draft-v1:"));
  assert.ok(!key.includes("reader-1"));
  const envelope=memory.getItem(key);
  assert.ok(!envelope.includes("中文") && !envelope.includes("私人") &&
    !envelope.includes("reader-1") && !envelope.includes("room-abc"));
  assert.equal(await hasEncryptedDraft(memory,scope),true);
  assert.equal(await recoverEncryptedDraft(memory,scope,pass),body);
  await removeEncryptedDraft(memory,scope);
  assert.equal(await recoverEncryptedDraft(memory,scope,pass),null);
});

test("wrong passphrases, tampering and another user's scope cannot unlock",async()=>{
  const memory=storage();
  await saveEncryptedDraft(memory,scope,"secret",pass);
  await assert.rejects(
    recoverEncryptedDraft(memory,scope,"incorrect-passphrase-here"),/解锁失败/);
  const others=[
    {...scope,userId:"reader-2"},
    {...scope,roomId:"room-different"},
    {...scope,kind:"reply",targetId:"chunk-42"},
    {...scope,targetId:"chunk-43"},
  ];
  for(const other of others) {
    assert.equal(await recoverEncryptedDraft(memory,other,pass),null);
  }
  // Moving ciphertext to a different scope key still fails: AES-GCM AAD
  // binds the record to its original reader, room, type and target.
  const copiedScope = others[0];
  memory.setItem(await encryptedDraftKey(copiedScope),
    memory.getItem(await encryptedDraftKey(scope)));
  await assert.rejects(
    recoverEncryptedDraft(memory,copiedScope,pass),/解锁失败/);
  const key=await encryptedDraftKey(scope);
  const value=JSON.parse(memory.getItem(key));
  value.ciphertext=value.ciphertext.replace(/^./,value.ciphertext[0]==="A"?"B":"A");
  memory.setItem(key,JSON.stringify(value));
  await assert.rejects(recoverEncryptedDraft(memory,scope,pass),/解锁失败/);
});

test("same plaintext saves fresh salt and IV, no deterministic ciphertext",async()=>{
  const memory=storage();
  await saveEncryptedDraft(memory,scope,"same plaintext",pass);
  const key=await encryptedDraftKey(scope);
  const first=memory.getItem(key);
  await saveEncryptedDraft(memory,scope,"same plaintext",pass);
  const next=memory.getItem(key);
  assert.notEqual(first,next);
  assert.equal(await recoverEncryptedDraft(memory,scope,pass),"same plaintext");
});

test("validation rejects short passphrases, missing data and oversized entries",async()=>{
  const memory=storage();
  await assert.rejects(saveEncryptedDraft(memory,scope,"text","short"),/12–128/);
  await assert.rejects(saveEncryptedDraft(memory,scope,"",pass),/为空/);
  await assert.rejects(saveEncryptedDraft(memory,scope,"🍀".repeat(3000),pass),/上限/);
  assert.equal(memory.contents.size,0);
  await assert.rejects(encryptedDraftKey({...scope,userId:""}),/草稿位置/);
});

test("corrupted format rejected without plaintext fallback",async()=>{
  const memory=storage();
  const key=await encryptedDraftKey(scope);
  memory.setItem(key,'{"v":1,"iterations":310000,"salt":"garbled","iv":"x","ciphertext":"x"}');
  await assert.rejects(recoverEncryptedDraft(memory,scope,pass),/无效/);
  memory.setItem(key,"{");
  await assert.rejects(recoverEncryptedDraft(memory,scope,pass),/损坏/);
});


test("offline pending message retains UUID and private scope after encrypted recovery",async()=>{
  const memory=storage();
  const operationId="f18b0cc7-918e-4bda-8cad-834241395de2";
  const pending={
    v:2,body:"只能我自己看见的批注",start:1,end:5,
    visibility:"private",operationId,
  };
  await saveEncryptedDraft(memory,scope,JSON.stringify(pending),pass);
  const first=JSON.parse(await recoverEncryptedDraft(memory,scope,pass));
  const next=JSON.parse(await recoverEncryptedDraft(memory,scope,pass));
  assert.equal(first.operationId,operationId);
  assert.equal(next.operationId,operationId);
  assert.equal(next.visibility,"private");
  assert.deepEqual(next,pending);
});
